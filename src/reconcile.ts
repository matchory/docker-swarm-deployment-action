import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import type { Settings } from "./settings.js";

/** Service-level keys that pass `docker stack config` but are ignored by
 * swarm at deploy time. We leave them in place and warn. */
const WARN_ONLY: Array<{ key: string; reason: string }> = [
  { key: "container_name", reason: "swarm names tasks itself" },
  {
    key: "build",
    reason: 'provide a pre-built "image" and push it to a registry',
  },
];

/** Keys handled by WARN_ONLY are valid Compose syntax we deliberately keep,
 * so unknown-key validation must never flag them. Derived from the table so a
 * new warn-only rule can't fall out of sync with KNOWN_SERVICE_KEYS. */
const WARN_ONLY_KEYS = new Set(WARN_ONLY.map((rule) => rule.key));

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
  {
    key: "cpu_shares",
    reason:
      "CPU shares are not supported by swarm; use deploy.resources.limits.cpus",
  },
  {
    key: "cpu_quota",
    reason:
      "CPU quota is not supported by swarm; use deploy.resources.limits.cpus",
  },
  { key: "cpuset", reason: "cpuset pinning is not supported by swarm" },
  {
    key: "cpu_count",
    reason:
      "cpu_count is not supported by swarm; use deploy.resources.limits.cpus",
  },
  { key: "cpu_percent", reason: "cpu_percent is not supported by swarm" },
  {
    key: "blkio_config",
    reason: "block IO configuration is not supported by swarm",
  },
  { key: "storage_opt", reason: "storage options are not supported by swarm" },
  {
    key: "runtime",
    reason: "container runtime selection is not supported by swarm",
  },
  {
    key: "oom_kill_disable",
    reason: "oom_kill_disable is not supported by swarm",
  },
  {
    key: "scale",
    reason: "scale is not supported by swarm; use deploy.replicas",
  },
];

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version",
  "name",
  "services",
  "networks",
  "volumes",
  "configs",
  "secrets",
  "include",
]);

const KNOWN_SERVICE_KEYS = new Set([
  "image",
  "build",
  "command",
  "entrypoint",
  "environment",
  "env_file",
  "ports",
  "expose",
  "volumes",
  "volumes_from",
  "networks",
  "network_mode",
  "depends_on",
  "restart",
  "deploy",
  "healthcheck",
  "labels",
  "label_file",
  "container_name",
  "hostname",
  "domainname",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "cap_add",
  "cap_drop",
  "devices",
  "security_opt",
  "sysctls",
  "ulimits",
  "user",
  "working_dir",
  "stop_grace_period",
  "stop_signal",
  "tty",
  "stdin_open",
  "init",
  "read_only",
  "privileged",
  "shm_size",
  "pid",
  "ipc",
  "cgroup",
  "cgroup_parent",
  "configs",
  "secrets",
  "logging",
  "mem_limit",
  "mem_reservation",
  "memswap_limit",
  "cpus",
  "cpu_shares",
  "cpu_quota",
  "cpu_count",
  "cpu_percent",
  "cpuset",
  "profiles",
  "develop",
  "post_start",
  "pre_stop",
  "provider",
  "gpus",
  "extends",
  "mac_address",
  "platform",
  "pull_policy",
  "isolation",
  "runtime",
  "group_add",
  "oom_score_adj",
  "oom_kill_disable",
  "links",
  "external_links",
  "blkio_config",
  "storage_opt",
  "annotations",
  "attach",
  "credential_spec",
  "device_cgroup_rules",
  "scale",
  "uts",
  "tmpfs",
  "pids_limit",
  "mem_swappiness",
  "cpu_period",
  "cpu_rt_period",
  "cpu_rt_runtime",
  "userns_mode",
  "models",
]);

// NOTE: this list is a best-effort typo catcher, not a schema. `docker stack
// config` (run downstream in normalizeSpec) is the authoritative validator, so
// unknown-key findings are advisory only and never fail the deploy on their
// own — a newly added Compose key we haven't listed yet produces at most a
// spurious warning, not a hard error.

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

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }
  return rows[a.length][b.length];
}

function closestKey(key: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestDistance = 3; // require distance <= 2
  for (const candidate of known) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function suggestion(key: string, known: Set<string>): string {
  const closest = closestKey(key, known);
  return closest ? ` — did you mean "${closest}"?` : "";
}

class Diagnostics {
  private readonly violations: string[] = [];

  /**
   * Record a swarm-incompatible feature that was removed, or a conflict we had
   * to resolve. Surfaced as a warning and counted as a strict-compatibility
   * violation (fails the deploy when `strict-compatibility` is enabled).
   */
  warn(message: string): void {
    core.warning(message);
    this.violations.push(message);
  }

  /**
   * Surface an advisory warning that must NOT fail strict mode: a kept-but-
   * ignored key (`build`, `container_name`) or a heuristic unknown-key guess.
   * `docker stack config` remains the authoritative validator for these.
   */
  advise(message: string): void {
    core.warning(message);
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
        `Service "${name}" sets both "${key}" and ` +
          `${path.join(".")}.${target}; keeping the deploy value and ` +
          `dropping "${key}".`,
      );
      continue;
    }
    node[target] = value;
    diagnostics.note(
      `Service "${name}": translated "${key}" to ${path.join(".")}.${target}.`,
    );
  }
}

function restartPolicy(restart: string): {
  condition: string;
  max_attempts?: number;
} {
  if (restart === "no") return { condition: "none" };
  if (restart === "always" || restart === "unless-stopped") {
    return { condition: "any" };
  }
  // "on-failure" or "on-failure:N" — preserve the max-attempts count.
  const match = restart.match(/^on-failure(?::(\d+))?$/);
  if (match?.[1]) {
    return { condition: "on-failure", max_attempts: Number(match[1]) };
  }
  return { condition: "on-failure" };
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
  const policy = restartPolicy(restart);
  if (restart === "unless-stopped") {
    diagnostics.warn(
      `Service "${name}": "restart: unless-stopped" has no swarm equivalent; ` +
        `translated to restart_policy condition "any".`,
    );
  } else {
    diagnostics.note(
      `Service "${name}": translated "restart: ${restart}" to ` +
        `deploy.restart_policy.condition "${policy.condition}".`,
    );
  }
  deploy.restart_policy = policy;
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

// Resolve a label_file path relative to the compose file's own directory
// (matching Docker's compose-file-relative resolution), then confine it to the
// workspace so a malicious compose file can't read arbitrary host files.
function withinWorkspace(path: string, baseDir: string): string | null {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  const resolved = resolve(baseDir, path);
  return resolved === workspace || resolved.startsWith(prefix)
    ? resolved
    : null;
}

function parseEnvFile(content: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    labels[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return labels;
}

function validateServiceKeys(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const key of Object.keys(service)) {
    if (
      key.startsWith("x-") ||
      KNOWN_SERVICE_KEYS.has(key) ||
      WARN_ONLY_KEYS.has(key)
    ) {
      continue;
    }
    diagnostics.advise(
      `Unknown property "${key}" on service "${name}"` +
        suggestion(key, KNOWN_SERVICE_KEYS) +
        ".",
    );
  }
}

function validateTopLevelKeys(
  spec: ComposeSpec,
  diagnostics: Diagnostics,
): void {
  for (const key of Object.keys(spec)) {
    if (key.startsWith("x-") || KNOWN_TOP_LEVEL_KEYS.has(key)) {
      continue;
    }
    diagnostics.advise(
      `Unknown top-level property "${key}"` +
        suggestion(key, KNOWN_TOP_LEVEL_KEYS) +
        ".",
    );
  }
}

function labelsToMap(labels: unknown): Record<string, string> {
  if (Array.isArray(labels)) {
    const map: Record<string, string> = {};
    for (const item of labels) {
      const str = String(item);
      const eq = str.indexOf("=");
      if (eq === -1) {
        map[str] = "";
      } else {
        map[str.slice(0, eq)] = str.slice(eq + 1);
      }
    }
    return map;
  }
  if (typeof labels === "object" && labels !== null) {
    return labels as Record<string, string>;
  }
  return {};
}

async function translateLabelFile(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
  baseDir: string,
): Promise<void> {
  if (!("label_file" in service)) {
    return;
  }
  const raw = service.label_file;
  delete service.label_file;
  const paths = Array.isArray(raw) ? raw.map(String) : [String(raw)];

  const fromFiles: Record<string, string> = {};
  for (const path of paths) {
    const resolved = withinWorkspace(path, baseDir);
    if (!resolved) {
      diagnostics.warn(
        `Service "${name}": label_file "${path}" resolves outside the ` +
          `workspace and was skipped.`,
      );
      continue;
    }
    try {
      Object.assign(fromFiles, parseEnvFile(await readFile(resolved, "utf8")));
    } catch (error) {
      // Never abort the whole deploy over an unreadable label_file (missing
      // file, permissions, or an un-interpolated ${VAR} in the path — this runs
      // before interpolation). Warn and continue; strict mode fails cleanly.
      diagnostics.warn(
        `Service "${name}": could not read label_file "${path}" ` +
          `(${(error as Error).message}); skipping its labels.`,
      );
    }
  }

  // Only touch `labels` when there is something to merge, so an all-skipped
  // label_file doesn't leave a spurious empty labels map behind.
  const merged = { ...fromFiles, ...labelsToMap(service.labels) };
  if (Object.keys(merged).length > 0) {
    service.labels = merged;
  }
  if (Object.keys(fromFiles).length > 0) {
    diagnostics.note(
      `Service "${name}": merged label_file entries into labels.`,
    );
  }
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
  services: Record<string, unknown>,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): boolean {
  if (!("provider" in service)) {
    return false;
  }
  delete services[name];
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
  baseDir: string = process.cwd(),
): Promise<void> {
  const diagnostics = new Diagnostics();
  const droppedServices: string[] = [];

  applyTopLevelStrips(spec, diagnostics);

  for (const [name, service] of Object.entries(spec.services)) {
    if (typeof service !== "object" || service === null) {
      diagnostics.warn(
        `Service "${name}" is not a valid mapping; skipping reconciliation.`,
      );
      continue;
    }
    const entry = service as Record<string, unknown>;
    if (applyProvider(name, spec.services, entry, diagnostics)) {
      droppedServices.push(name);
      continue;
    }
    translateResources(name, entry, diagnostics);
    translateRestart(name, entry, diagnostics);
    translateDependsOn(name, entry, diagnostics);
    await translateLabelFile(name, entry, diagnostics, baseDir);
    applyStrips(name, entry, diagnostics);
    applyWarnOnly(name, entry, diagnostics);
    validateServiceKeys(name, entry, diagnostics);
  }

  // Removing provider services can leave siblings depending on names that no
  // longer exist; strip those references so `docker stack config` doesn't
  // reject the stack. depends_on is an array by now (translateDependsOn ran).
  stripDroppedDependencies(spec.services, droppedServices, diagnostics);

  validateTopLevelKeys(spec, diagnostics);
  diagnostics.finish(settings.strictCompatibility);
}

function stripDroppedDependencies(
  services: Record<string, unknown>,
  dropped: string[],
  diagnostics: Diagnostics,
): void {
  if (dropped.length === 0) {
    return;
  }
  const droppedSet = new Set(dropped);
  for (const [name, service] of Object.entries(services)) {
    if (typeof service !== "object" || service === null) {
      continue;
    }
    const entry = service as Record<string, unknown>;
    if (!Array.isArray(entry.depends_on)) {
      continue;
    }
    const kept = entry.depends_on.filter((dep) => !droppedSet.has(String(dep)));
    if (kept.length === entry.depends_on.length) {
      continue;
    }
    if (kept.length === 0) {
      delete entry.depends_on;
    } else {
      entry.depends_on = kept;
    }
    diagnostics.advise(
      `Service "${name}": dropped depends_on reference(s) to removed ` +
        `provider service(s).`,
    );
  }
}

function applyWarnOnly(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const { key, reason } of WARN_ONLY) {
    if (key in service) {
      diagnostics.advise(
        `Service "${name}" sets "${key}", which Docker Swarm ignores; ${reason}.`,
      );
    }
  }
}
