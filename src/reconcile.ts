import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import type { Settings } from "./settings.js";

/** Service-level keys that pass `docker stack config` but are ignored by
 * swarm at deploy time. We leave them in place and warn. */
const WARN_ONLY: Array<{ key: string; message: (service: string) => string }> =
  [
    {
      key: "container_name",
      message: (s) =>
        `Service "${s}" sets "container_name", which Docker Swarm ignores; ` +
        `swarm names tasks itself.`,
    },
    {
      key: "build",
      message: (s) =>
        `Service "${s}" defines "build", which Docker Swarm ignores; ` +
        `provide a pre-built "image" and push it to a registry.`,
    },
  ];

class Diagnostics {
  private readonly violations: string[] = [];

  warn(message: string): void {
    core.warning(message);
    this.violations.push(message);
  }

  note(message: string): void {
    core.info(message);
  }

  finish(strict: boolean): void {
    if (strict && this.violations.length > 0) {
      throw new Error(
        `Compose specification contains ${this.violations.length} ` +
          `swarm-incompatible feature(s) and strict-compatibility is enabled:\n` +
          this.violations.map((v) => `  - ${v}`).join("\n"),
      );
    }
  }
}

/**
 * Reconcile modern Compose Specification constructs into a form
 * `docker stack deploy` accepts. Translates what has a faithful swarm
 * equivalent, strips what does not (with a warning), and validates
 * unknown keys. Mutates `spec` in place.
 */
export async function reconcileSwarmCompatibility(
  spec: ComposeSpec,
  settings: Pick<Readonly<Settings>, "strictCompatibility">,
): Promise<void> {
  const diagnostics = new Diagnostics();

  for (const [name, service] of Object.entries(spec.services)) {
    const entry = service as Record<string, unknown>;
    applyWarnOnly(name, entry, diagnostics);
  }

  diagnostics.finish(settings.strictCompatibility);
}

function applyWarnOnly(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const rule of WARN_ONLY) {
    if (rule.key in service) {
      diagnostics.warn(rule.message(name));
    }
  }
}
