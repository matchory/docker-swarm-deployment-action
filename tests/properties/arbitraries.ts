import fc from "fast-check";
import type { ComposeSpec } from "../../src/compose.js";
import { Tagged } from "../../src/override-tags.js";
import type { Inputs } from "./pipeline.js";

// A grammar of the Compose features the action processes itself, rather than
// passing them through to Docker. Grow it when a bug is found outside it.

export const image = "busybox:1.37";

const names = ["a", "b", "c", "d"];

// `${PROFILE}` resolves to "x" or to a profile no input activates
const profileName = fc.constantFrom("x", "y", "${PROFILE}");
const profiles = fc.uniqueArray(profileName, { minLength: 1, maxLength: 2 });

const word = fc.constantFrom("one", "two", "three");
const environment = fc.dictionary(fc.constantFrom("E1", "E2"), word, {
  maxKeys: 2,
});
const labels = fc.dictionary(fc.constantFrom("l.one", "l.two"), word, {
  maxKeys: 2,
});
const command = fc.constantFrom(["sleep", "1"], ["sleep", "2"]);

// Dependencies only point at services later in `names`, and `extends` only at
// earlier ones, so neither can form a cycle
function dependsOn(index: number) {
  const later = names.slice(index + 1);

  return fc.oneof(
    fc.subarray(later, { minLength: 1 }),
    fc
      .subarray(later, { minLength: 1 })
      .chain((targets) =>
        fc.tuple(
          ...targets.map((target) =>
            fc
              .record(
                {
                  condition: fc.constant("service_started"),
                  required: fc.constant(false),
                },
                { requiredKeys: ["condition"] },
              )
              .map((options) => [target, options] as const),
          ),
        ),
      )
      .map((entries) => Object.fromEntries(entries)),
  );
}

function baseService(index: number) {
  return fc
    .record(
      {
        image: fc.constant(image),
        command,
        environment,
        labels,
        deploy: fc.record(
          { labels, replicas: fc.integer({ min: 1, max: 3 }) },
          { requiredKeys: [] },
        ),
        profiles,
        depends_on: later(index) ? dependsOn(index) : fc.constant(undefined),
        extends:
          index > 0
            ? fc.constantFrom(...names.slice(0, index))
            : fc.constant(undefined),
        // A missing env file fails the whole input unless skipped, so rare
        env_file: fc.constantFrom(
          undefined,
          undefined,
          undefined,
          "./present.env",
          "./missing.env",
        ),
      },
      { requiredKeys: ["image"] },
    )
    .map(withoutUndefined);
}

function later(index: number) {
  return index < names.length - 1;
}

const overrideService = fc.oneof(
  fc
    .record(
      {
        command,
        environment,
        labels,
        deploy: fc.record({ labels }, { requiredKeys: [] }),
        env_file: fc.constant("./other.env"),
        profiles: fc.oneof(
          profiles,
          fc.constant(new Tagged("!reset", "sequence", [])),
        ),
      },
      { requiredKeys: [] },
    )
    .filter((service) => Object.keys(service).length > 0),
  // A whole service replaced, dropping its profiles
  command.map(
    (value) =>
      new Tagged(
        "!override",
        "mapping",
        new Map<string, unknown>([
          ["image", image],
          ["command", value],
        ]),
      ),
  ),
);

/**
 * Inputs of up to three files: a base file defining every service, and
 * override files changing some of them
 */
export const inputs: fc.Arbitrary<Inputs> = fc
  .subarray(names, { minLength: 1 })
  .chain((defined) =>
    fc.record({
      files: fc
        .tuple(
          fc
            .tuple(...defined.map((name) => baseService(names.indexOf(name))))
            .map((services) =>
              withoutInheritedCycles({
                services: Object.fromEntries(
                  services.map((service, index) => [
                    defined[index],
                    pruneReferences(service, defined),
                  ]),
                ),
              }),
            ),
          fc.array(
            fc
              .dictionary(fc.constantFrom(...defined), overrideService, {
                minKeys: 1,
                maxKeys: 2,
              })
              .map((services) => ({ services })),
            { maxLength: 2 },
          ),
        )
        .map(([base, overrides]) => [base, ...overrides] as ComposeSpec[]),
      profiles: fc.option(
        fc.uniqueArray(fc.constantFrom("x", "y", "z", "*"), {
          minLength: 1,
          maxLength: 2,
        }),
        { nil: undefined },
      ),
      variables: fc.record({ PROFILE: fc.constantFrom("x", "z") }),
    }),
  );

// Drop references to services the base file does not define
function pruneReferences(
  service: Record<string, unknown>,
  defined: string[],
): Record<string, unknown> {
  const result = { ...service };

  if (typeof result.extends === "string" && !defined.includes(result.extends)) {
    delete result.extends;
  }

  if (Array.isArray(result.depends_on)) {
    const kept = result.depends_on.filter((name) => defined.includes(name));
    result.depends_on = kept.length > 0 ? kept : undefined;
  } else if (result.depends_on) {
    const kept = Object.entries(result.depends_on).filter(([name]) =>
      defined.includes(name),
    );
    result.depends_on = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  }

  return withoutUndefined(result);
}

// A service inherits the dependencies of the one it extends, so an extended
// service depending on a later one could make that service depend on itself
function withoutInheritedCycles(spec: {
  services: Record<string, Record<string, unknown>>;
}) {
  for (const service of Object.values(spec.services)) {
    if (typeof service.extends === "string") {
      delete spec.services[service.extends].depends_on;
    }
  }

  return spec;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/**
 * A variable value: anything a workflow could pass, including the characters
 * interpolation and YAML treat specially
 */
const value = fc.oneof(
  fc.string(),
  fc.string({ unit: "grapheme" }),
  fc.stringMatching(/^[$\\{}'"#:\s-]*$/),
);

/**
 * One service using a variable in its environment and labels, and in a label
 * key, with or without key interpolation
 */
export const interpolation = fc.record({
  value,
  keyInterpolation: fc.boolean(),
});

/**
 * A value of a service label the action reads, as YAML can write it
 */
export const labelValue = fc.oneof(
  fc.boolean(),
  fc.integer({ min: -5, max: 1_000 }),
  fc.double({ noNaN: true }),
  fc.constantFrom("true", "false", "yes", "10", "10s", "0", "-1", "", "1.5"),
  fc.string(),
);
