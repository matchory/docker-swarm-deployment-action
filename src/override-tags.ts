import {
  defineMappingTag,
  defineScalarTag,
  defineSequenceTag,
  type TagDefinition,
} from "js-yaml";
import { deployFoldingKeys, reconciledServiceKeys } from "./reconcile.js";

/** In-memory carrier for a `!reset` / `!override`-tagged YAML node, preserved
 * through the action's transform and re-emitted on dump. */
export class Tagged {
  constructor(
    readonly tag: string,
    readonly kind: "scalar" | "sequence" | "mapping",
    readonly value: unknown,
  ) {}
}

const isTagged =
  (tag: string, kind: Tagged["kind"]) =>
  (value: unknown): value is Tagged =>
    value instanceof Tagged && value.tag === tag && value.kind === kind;

// One scalar/sequence/mapping definition per tag, so a future standard tag is
// a one-line addition to `overrideTagDefinitions`.
function overrideTag(tag: string): TagDefinition[] {
  return [
    defineScalarTag(tag, {
      resolve: (source: string) => new Tagged(tag, "scalar", source),
      identify: isTagged(tag, "scalar"),
      represent: (value) => String((value as Tagged).value),
    }),
    defineSequenceTag(tag, {
      create: () => new Tagged(tag, "sequence", []),
      addItem: (carrier, item) => {
        ((carrier as Tagged).value as unknown[]).push(item);
      },
      identify: isTagged(tag, "sequence"),
      represent: (value) => (value as Tagged).value as unknown[],
    }),
    defineMappingTag(tag, {
      create: () => new Tagged(tag, "mapping", new Map<unknown, unknown>()),
      addPair: (carrier, key, val) => {
        ((carrier as Tagged).value as Map<unknown, unknown>).set(key, val);
        return ""; // js-yaml: empty string signals a successful pair add
      },
      has: (carrier, key) =>
        ((carrier as Tagged).value as Map<unknown, unknown>).has(key),
      keys: (carrier) => [
        ...((carrier as Tagged).value as Map<unknown, unknown>).keys(),
      ],
      get: (carrier, key) =>
        ((carrier as Tagged).value as Map<unknown, unknown>).get(key),
      identify: isTagged(tag, "mapping"),
      represent: (value) => (value as Tagged).value as Map<unknown, unknown>,
    }),
  ];
}

export const overrideTagDefinitions: TagDefinition[] = [
  ...overrideTag("!override"),
  ...overrideTag("!reset"),
];

/** Deep-scan a parsed spec for any `Tagged` carrier. */
export function containsOverrideTag(value: unknown): boolean {
  if (value instanceof Tagged) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsOverrideTag);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      containsOverrideTag,
    );
  }
  return false;
}

/**
 * Reject `!reset` / `!override` tags placed on keys the action rewrites for
 * Swarm. Those tags apply to mergeable collections (ports, volumes,
 * environment, …), not scalar runtime knobs — using them there is a mistake we
 * surface instead of silently mis-transforming. The sensitive-key lists come
 * from `reconcile.ts` so they can't drift from the transforms they guard.
 */
export function assertMergeableTagUsage(spec: {
  services?: Record<string, unknown>;
}): void {
  for (const [name, service] of Object.entries(spec.services ?? {})) {
    if (!service || typeof service !== "object") {
      continue;
    }
    const entry = service as Record<string, unknown>;
    for (const key of reconciledServiceKeys) {
      if (entry[key] instanceof Tagged) {
        throw new Error(
          `Service "${name}" applies the "${(entry[key] as Tagged).tag}" ` +
            `merge tag to "${key}", which the action rewrites for Swarm ` +
            `compatibility. The "!reset"/"!override" tags apply to mergeable ` +
            `collections (e.g. ports, volumes, environment), not "${key}".`,
        );
      }
    }

    const deploy = entry.deploy;
    if (
      deploy instanceof Tagged &&
      deployFoldingKeys.some((key) => key in entry)
    ) {
      throw new Error(
        `Service "${name}" applies the "${deploy.tag}" merge tag to ` +
          `"deploy" while also setting a short-form key (restart / mem_limit / ` +
          `cpus / mem_reservation) that the action folds into "deploy". The ` +
          `translated value would be lost during the merge — move the setting ` +
          `into the overriding "deploy" block, or remove the tag.`,
      );
    }
    const labels = entry.labels;
    if (labels instanceof Tagged && "label_file" in entry) {
      throw new Error(
        `Service "${name}" applies the "${labels.tag}" merge tag to ` +
          `"labels" while also using "label_file". Merging the label file into ` +
          `a tagged labels block would corrupt it — inline the label_file ` +
          `entries into the "labels" block, or remove the tag.`,
      );
    }
  }
}
