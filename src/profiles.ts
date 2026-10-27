import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import { Tagged } from "./override-tags.js";

/**
 * Keep only the services of the active profiles
 *
 * Follows Compose: a service is deployed if it has no profiles or one of them
 * is active, and "*" activates every profile. A service's profiles are
 * combined across files, as Compose merges them. The kept services lose their
 * `profiles`, which Swarm does not support.
 *
 * Runs on the loaded files before they are reconciled and merged, because
 * reconciling a file on its own strips its profiles.
 *
 * @param specs Loaded Compose files, in merge order; modified in place
 * @param active Profiles to activate
 */
export function selectProfiles(
  specs: ReadonlyArray<{ spec: ComposeSpec }>,
  active: readonly string[],
) {
  const profiles = new Map<string, string[]>();

  for (const { spec } of specs) {
    for (const [name, service] of Object.entries(spec.services)) {
      const value = (service as { profiles?: unknown } | null)?.profiles;

      if (value instanceof Tagged) {
        profiles.set(name, value.tag === "!reset" ? [] : toList(value.value));
      } else if (value !== undefined) {
        profiles.set(name, [...(profiles.get(name) ?? []), ...toList(value)]);
      }
    }
  }

  const inactive = new Map(
    [...profiles].filter(
      ([, names]) =>
        names.length > 0 &&
        !active.includes("*") &&
        !names.some((profile) => active.includes(profile)),
    ),
  );

  for (const [name, names] of inactive) {
    core.info(
      `Skipping service "${name}": none of its profiles (${names.join(", ")}) ` +
        `is active`,
    );
  }

  for (const { spec } of specs) {
    for (const name of inactive.keys()) {
      delete spec.services[name];
    }

    for (const [name, service] of Object.entries(spec.services)) {
      if (typeof service !== "object" || service === null) {
        continue;
      }

      delete (service as { profiles?: unknown }).profiles;

      for (const dependency of dependencies(service)) {
        const names = inactive.get(dependency);

        if (names) {
          throw new Error(
            `Service "${name}" depends on service "${dependency}", which is ` +
              `not deployed because none of its profiles ` +
              `(${names.join(", ")}) is active. Activate one of them with ` +
              `the "profiles" input, or remove the dependency.`,
          );
        }
      }
    }
  }
}

function toList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(String);
}

// depends_on is either a list of names or a mapping keyed by them
function dependencies(service: object): string[] {
  const dependsOn = (service as { depends_on?: unknown }).depends_on;

  if (Array.isArray(dependsOn)) {
    return dependsOn.map(String);
  }

  if (typeof dependsOn === "object" && dependsOn !== null) {
    return Object.keys(dependsOn);
  }

  return [];
}
