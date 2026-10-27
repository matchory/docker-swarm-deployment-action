import type { ComposeSpec } from "./compose.js";
import { labelsToMap } from "./reconcile.js";
import type { Settings } from "./settings.js";
import { versionLabel } from "./variables.js";

// Read from a service's `deploy.labels`, overriding the stack-wide setting
export const monitorLabel = "com.matchory.deployment.monitor";
export const monitorTimeoutLabel = "com.matchory.deployment.monitor-timeout";
export const healthCheckWarningsLabel =
  "com.matchory.deployment.health-check-warnings";

// Written to every service's `deploy.labels`, alongside `versionLabel`
export const commitLabel = "com.matchory.deployment.commit";
export const refLabel = "com.matchory.deployment.ref";
export const runUrlLabel = "com.matchory.deployment.run-url";
export const actorLabel = "com.matchory.deployment.actor";

/**
 * A kind of setting value: how to parse it, and what it must be
 */
export interface ValueType<T> {
  parse: (value: unknown) => T | undefined;
  expected: string;
}

export const booleanValue: ValueType<boolean> = {
  parse: parseBoolean,
  expected: "true or false",
};

export const listValue: ValueType<string[]> = {
  parse: (value) => {
    if (typeof value === "string") {
      return value.split(/[\s,]+/).filter(Boolean);
    }

    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value
      : undefined;
  },
  expected: "a list of names",
};

export const secondsValue: ValueType<number> = {
  parse: parseSeconds,
  expected: "a positive whole number of seconds",
};

/**
 * Parse a setting value, or throw naming the setting
 *
 * @param value Value to parse
 * @param type Kind of value expected
 * @param subject Description of the setting, starting the error message
 */
export function parseValue<T>(
  value: unknown,
  type: ValueType<T>,
  subject: string,
): T {
  const parsed = type.parse(value);

  if (parsed === undefined) {
    throw new Error(`${subject} must be ${type.expected}, but is "${value}".`);
  }

  return parsed;
}

/**
 * Settings that a service can override with a label
 */
export interface ServiceOptions {
  healthCheckWarnings: boolean;
  monitor: boolean;
  monitorTimeout: number;
}

/**
 * Resolve the options of every service in the spec
 *
 * A label on the service wins over the stack-wide setting. Labels are read
 * from the interpolated spec, so their values may use variables. An invalid
 * value throws, which is why this runs before the stack is deployed.
 *
 * @param spec Interpolated Compose spec
 * @param settings Stack-wide settings the labels override
 * @returns Options keyed by the service name in the spec
 */
export function resolveServiceOptions(
  spec: ComposeSpec,
  settings: Pick<
    Readonly<Settings>,
    "healthCheckWarnings" | "monitor" | "monitorTimeout"
  >,
) {
  const options = new Map<string, ServiceOptions>();

  for (const [name, service] of Object.entries(spec.services)) {
    const labels = labelsToMap(
      (service as { deploy?: { labels?: unknown } } | null)?.deploy?.labels,
    );
    const read = <T>(label: string, type: ValueType<T>) =>
      label in labels
        ? parseValue(
            labels[label],
            type,
            `The "${label}" label of service "${name}"`,
          )
        : undefined;

    options.set(name, {
      healthCheckWarnings:
        read(healthCheckWarningsLabel, booleanValue) ??
        settings.healthCheckWarnings,
      monitor: read(monitorLabel, booleanValue) ?? settings.monitor,
      monitorTimeout:
        read(monitorTimeoutLabel, secondsValue) ?? settings.monitorTimeout,
    });
  }

  return options;
}

/**
 * Add deployment labels to every service
 *
 * They go on the service (`deploy.labels`), not its containers (`labels`):
 * changing a service label updates the service without restarting its tasks,
 * so a new commit does not roll every service of the stack.
 *
 * @param spec Compose spec to deploy
 * @param labels Labels to add; they replace labels of the same name
 * @returns A copy of the spec with the labels added
 */
export function addDeploymentLabels(
  spec: ComposeSpec,
  labels: Readonly<Record<string, string>>,
): ComposeSpec {
  if (Object.keys(labels).length === 0) {
    return spec;
  }

  const services = Object.fromEntries(
    Object.entries(spec.services).map(([name, service]) => {
      const { deploy = {}, ...rest } = (service ?? {}) as {
        deploy?: { labels?: unknown };
      };

      return [
        name,
        {
          ...rest,
          deploy: {
            ...deploy,
            labels: { ...labelsToMap(deploy.labels), ...labels },
          },
        },
      ];
    }),
  );

  return { ...spec, services };
}

/**
 * Infer the deployment labels from the GitHub Actions environment
 *
 * Variables the runner does not set are left out instead of written empty.
 */
export function inferDeploymentLabels(
  version: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : undefined;
  const labels = {
    [versionLabel]: version,
    [commitLabel]: env.GITHUB_SHA,
    [refLabel]: env.GITHUB_REF,
    [runUrlLabel]: runUrl,
    [actorLabel]: env.GITHUB_ACTOR,
  };

  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  );
}

/**
 * Parse a boolean from YAML or a label
 *
 * Accepts the same spellings as boolean action inputs.
 *
 * @returns The boolean, or undefined if the value is not one
 */
export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  const text = String(value);

  if (["true", "True", "TRUE"].includes(text)) {
    return true;
  }

  if (["false", "False", "FALSE"].includes(text)) {
    return false;
  }

  return undefined;
}

/**
 * Parse a positive whole number of seconds from YAML or a label
 *
 * @returns The number, or undefined if the value is not one
 */
export function parseSeconds(value: unknown): number | undefined {
  const text = String(value);

  // Only plain digits are accepted. `Number.parseInt` would silently truncate
  // instead of rejecting: it reads "5.9" as 5, "10s" as 10, and "1e3" as 1 --
  // a thousandth of the duration the author asked for.
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    return undefined;
  }

  return Number(text);
}
