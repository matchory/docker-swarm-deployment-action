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
