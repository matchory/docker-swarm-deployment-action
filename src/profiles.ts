import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import { Tagged } from "./override-tags.js";
import { interpolateString } from "./utils.js";

/**
 * Keep only the services of the active profiles
 *
 * Follows Compose: a service is deployed if it has no profiles or one of them
 * is active, and "*" activates every profile. A service's profiles are
 * combined across files and inherited through `extends`, as Compose does, and
 * are interpolated. The kept services lose their `profiles`, which Swarm does
 * not support, and their dependencies on skipped services.
 *
 * Runs on the parsed files, before anything else reads them: reconciling a
 * file on its own strips its profiles, and the env files and variables of a
 * skipped service must not be required.
 *
 * @param specs Parsed Compose files, in merge order; modified in place
 * @param active Profiles to activate
 * @param variables Variables to interpolate profile names with
 */
export function selectProfiles(
  specs: ReadonlyArray<{ spec: ComposeSpec | undefined }>,
  active: readonly string[],
  variables: Map<string, string>,
) {
  const own = new Map<string, string[]>();
  const bases = new Map<string, string>();

  for (const { spec } of specs) {
    for (const [name, service] of Object.entries(spec?.services ?? {})) {
      // A service tagged as a whole replaces the earlier definitions
      const replaces = service instanceof Tagged;
      const profiles = field(service, "profiles");
      const names =
        profiles instanceof Tagged
          ? profiles.tag === "!reset"
            ? []
            : toList(profiles.value)
          : toList(profiles);

      own.set(
        name,
        replaces || profiles instanceof Tagged
          ? names
          : [...(own.get(name) ?? []), ...names],
      );

      const base = extendedService(field(service, "extends"));

      if (base) {
        bases.set(name, base);
      } else if (replaces) {
        bases.delete(name);
      }
    }
  }

  const profilesOf = (name: string, seen = new Set<string>()): string[] => {
    const base = bases.get(name);
    const inherited =
      base && !seen.has(base) ? profilesOf(base, new Set([...seen, name])) : [];

    return [
      ...new Set(
        [...inherited, ...(own.get(name) ?? [])].map((profile) =>
          interpolateString(profile, variables),
        ),
      ),
    ];
  };
  const inactive = new Map(
    [...own.keys()]
      .map((name) => [name, profilesOf(name)] as const)
      .filter(
        ([, names]) =>
          names.length > 0 &&
          !active.includes("*") &&
          !names.some((profile) => active.includes(profile)),
      ),
  );
  const reason = (name: string) =>
    `none of its profiles (${inactive.get(name)?.join(", ")}) is active`;

  for (const [name, base] of bases) {
    if (!inactive.has(name) && inactive.has(base)) {
      throw new Error(
        `Service "${name}" extends service "${base}", which is not deployed ` +
          `because ${reason(base)}. A stack can only extend services it ` +
          `deploys: activate one of those profiles with the "profiles" ` +
          `input, or move the shared settings into an extension field.`,
      );
    }
  }

  for (const name of inactive.keys()) {
    core.info(`Skipping service "${name}": ${reason(name)}`);
  }

  for (const { spec } of specs) {
    if (!spec?.services) {
      continue;
    }

    for (const name of inactive.keys()) {
      delete spec.services[name];
    }

    for (const [name, service] of Object.entries(spec.services)) {
      removeField(service, "profiles");

      for (const dependency of removeDependencies(service, inactive)) {
        core.warning(
          `Service "${name}" depends on service "${dependency}", which is ` +
            `not deployed because ${reason(dependency)}; removed the ` +
            `dependency.`,
        );
      }
    }
  }
}

// Read a key of a service, which may be tagged with !override as a whole
function field(service: unknown, key: string): unknown {
  if (service instanceof Tagged) {
    return service.value instanceof Map ? service.value.get(key) : undefined;
  }

  return typeof service === "object" && service !== null
    ? (service as Record<string, unknown>)[key]
    : undefined;
}

function removeField(service: unknown, key: string) {
  if (service instanceof Tagged) {
    if (service.value instanceof Map) {
      service.value.delete(key);
    }
  } else if (typeof service === "object" && service !== null) {
    delete (service as Record<string, unknown>)[key];
  }
}

function toList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).map(String);
}

// `extends: base` or `extends: {service: base}`; a base in another file is
// resolved by Docker and cannot be checked here
function extendedService(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const extended = value instanceof Tagged ? value.value : value;

  if (extended instanceof Map) {
    return extended.has("file") ? undefined : String(extended.get("service"));
  }

  if (typeof extended === "object" && extended !== null) {
    const { file, service } = extended as { file?: unknown; service?: unknown };

    return file === undefined && service !== undefined
      ? String(service)
      : undefined;
  }

  return undefined;
}

// Remove dependencies on skipped services from `depends_on`, a list of names
// or a mapping keyed by them, possibly tagged; returns the removed names
function removeDependencies(
  service: unknown,
  inactive: ReadonlyMap<string, unknown>,
): string[] {
  const dependsOn = field(service, "depends_on");
  const value = dependsOn instanceof Tagged ? dependsOn.value : dependsOn;
  const removed: string[] = [];

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (inactive.has(String(value[i]))) {
        removed.unshift(String(value.splice(i, 1)[0]));
      }
    }
  } else if (value instanceof Map) {
    for (const key of [...value.keys()]) {
      if (inactive.has(String(key))) {
        value.delete(key);
        removed.push(String(key));
      }
    }
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      if (inactive.has(key)) {
        delete (value as Record<string, unknown>)[key];
        removed.push(key);
      }
    }
  }

  return removed;
}
