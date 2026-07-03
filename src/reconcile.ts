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

const STRIP_KEYS: Array<{ key: string; reason: string }> = [
  {
    key: "develop",
    reason: "development watch config is not supported by swarm",
  },
  { key: "post_start", reason: "lifecycle hooks are not supported by swarm" },
  { key: "pre_stop", reason: "lifecycle hooks are not supported by swarm" },
  {
    key: "profiles",
    reason:
      "profiles are not supported by swarm; all services are always deployed",
  },
  { key: "memswap_limit", reason: "swarm has no swap-limit control" },
  {
    key: "gpus",
    reason:
      "GPU shorthand is not supported by swarm; use " +
      "deploy.resources.reservations.generic_resources with node labels",
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

function applyStrips(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const { key, reason } of STRIP_KEYS) {
    if (key in service) {
      delete service[key];
      diagnostics.warn(`Service "${name}": removed "${key}" — ${reason}.`);
    }
  }
}

function applyProvider(
  name: string,
  spec: ComposeSpec,
  diagnostics: Diagnostics,
): boolean {
  const service = spec.services[name] as Record<string, unknown>;
  if (!("provider" in service)) {
    return false;
  }
  delete spec.services[name];
  diagnostics.warn(
    `Service "${name}" is a provider service, which Docker Swarm cannot run; ` +
      `the service has been removed from the stack.`,
  );
  return true;
}

function applyTopLevelStrips(
  spec: ComposeSpec,
  diagnostics: Diagnostics,
): void {
  if ("models" in spec) {
    delete spec.models;
    diagnostics.warn(
      `Removed top-level "models" — the model runner is not supported by swarm.`,
    );
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

  applyTopLevelStrips(spec, diagnostics);

  for (const [name, service] of Object.entries(spec.services)) {
    if (applyProvider(name, spec, diagnostics)) {
      continue;
    }
    const entry = service as Record<string, unknown>;
    translateResources(name, entry, diagnostics);
    translateRestart(name, entry, diagnostics);
    translateDependsOn(name, entry, diagnostics);
    applyStrips(name, entry, diagnostics);
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
