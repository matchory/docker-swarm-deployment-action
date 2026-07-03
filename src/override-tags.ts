import {
  defineMappingTag,
  defineScalarTag,
  defineSequenceTag,
  type TagDefinition,
} from "js-yaml";

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

/** Service keys reconciliation reads or rewrites; a merge tag on any of them
 * would be mis-transformed, so we reject it up front. */
export const tagSensitiveServiceKeys = [
  "mem_limit",
  "mem_reservation",
  "cpus",
  "restart",
  "depends_on",
  "label_file",
] as const;

/**
 * Reject `!reset` / `!override` tags placed on keys the action rewrites for
 * Swarm. Those tags apply to mergeable collections (ports, volumes,
 * environment, …), not scalar runtime knobs — using them there is a mistake we
 * surface instead of silently mis-transforming.
 */
export function assertMergeableTagUsage(spec: {
  services?: Record<string, unknown>;
}): void {
  for (const [name, service] of Object.entries(spec.services ?? {})) {
    if (!service || typeof service !== "object") {
      continue;
    }
    const entry = service as Record<string, unknown>;
    for (const key of tagSensitiveServiceKeys) {
      if (entry[key] instanceof Tagged) {
        throw new Error(
          `Service "${name}" applies the "${(entry[key] as Tagged).tag}" ` +
            `merge tag to "${key}", which the action rewrites for Swarm ` +
            `compatibility. The "!reset"/"!override" tags apply to mergeable ` +
            `collections (e.g. ports, volumes, environment), not "${key}".`,
        );
      }
    }
  }
}
