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

const RESOURCE_TRANSLATIONS: Array<{
  key: string;
  path: string[];
  target: string;
}> = [
  {
    key: "mem_limit",
    path: ["deploy", "resources", "limits"],
    target: "memory",
  },
  { key: "cpus", path: ["deploy", "resources", "limits"], target: "cpus" },
  {
    key: "mem_reservation",
    path: ["deploy", "resources", "reservations"],
    target: "memory",
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

function ensurePath(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let node = root;
  for (const key of path) {
    if (typeof node[key] !== "object" || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  return node;
}

function translateResources(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const { key, path, target } of RESOURCE_TRANSLATIONS) {
    if (!(key in service)) {
      continue;
    }
    const value = String(service[key]);
    delete service[key];
    const node = ensurePath(service, path);
    if (target in node) {
      diagnostics.warn(
        `Service "${name}" sets both "${key}" and deploy.resources.` +
          `${path[2]}.${target}; keeping the deploy value and dropping "${key}".`,
      );
      continue;
    }
    node[target] = value;
    diagnostics.note(
      `Service "${name}": translated "${key}" to deploy.resources.` +
        `${path[2]}.${target}.`,
    );
  }
}

function restartCondition(restart: string): string {
  if (restart === "no") return "none";
  if (restart === "always" || restart === "unless-stopped") return "any";
  return "on-failure"; // covers "on-failure" and "on-failure:N"
}

function translateRestart(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  if (!("restart" in service)) {
    return;
  }
  const restart = String(service.restart);
  delete service.restart;
  const deploy = ensurePath(service, ["deploy"]);
  if ("restart_policy" in deploy) {
    diagnostics.warn(
      `Service "${name}" sets both "restart" and deploy.restart_policy; ` +
        `keeping deploy.restart_policy and dropping "restart".`,
    );
    return;
  }
  if (restart === "unless-stopped") {
    diagnostics.warn(
      `Service "${name}": "restart: unless-stopped" has no swarm equivalent; ` +
        `translated to restart_policy condition "any".`,
    );
  } else {
    diagnostics.note(
      `Service "${name}": translated "restart: ${restart}" to ` +
        `deploy.restart_policy.condition "${restartCondition(restart)}".`,
    );
  }
  deploy.restart_policy = { condition: restartCondition(restart) };
}

function translateDependsOn(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  const dependsOn = service.depends_on;
  if (
    typeof dependsOn !== "object" ||
    dependsOn === null ||
    Array.isArray(dependsOn)
  ) {
    return;
  }
  service.depends_on = Object.keys(dependsOn);
  diagnostics.warn(
    `Service "${name}" uses the long "depends_on" syntax; Docker Swarm has ` +
      `no startup ordering, so conditions are dropped and only the ` +
      `dependency list is kept.`,
  );
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
    translateResources(name, entry, diagnostics);
    translateRestart(name, entry, diagnostics);
    translateDependsOn(name, entry, diagnostics);
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
