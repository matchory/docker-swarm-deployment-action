import { debug } from "node:util";
import {
  getBooleanInput,
  getInput,
  info,
  setSecret,
  warning,
} from "@actions/core";
import { inferDeploymentLabels, parseBoolean, parseSeconds } from "./labels.js";

/**
 * Deployment settings
 */
export interface Settings {
  composeFiles?: string[];
  /**
   * Labels written to every service; see `addDeploymentLabels`
   */
  deploymentLabels?: Readonly<Record<string, string>>;
  envVarPrefix: string;
  /**
   * Stack settings given as workflow inputs, which the Compose file's
   * settings block cannot override
   */
  explicitInputs?: ReadonlySet<string>;
  healthCheckWarnings: boolean;
  keyInterpolation: boolean;
  manageVariables: boolean;
  monitor: boolean;
  monitorInterval: number;
  monitorTimeout: number;
  /**
   * Values that came from the `secrets` input, keyed by variable name
   *
   * Used to redact copies of the spec that leave the job; see
   * `redactSecretValues` for why, and for what is deliberately not redacted.
   */
  secretValues: ReadonlyMap<string, string>;
  stack: string;
  strictCompatibility: boolean;
  strictVariables: boolean;
  uploadComposeSpec: boolean;
  variables: Map<string, string>;
  version: string;
}

export function defineSettings<T extends Settings>(settings: T) {
  return settings;
}

/**
 * Top-level Compose extension holding stack settings
 */
export const stackSettingsKey = "x-matchory-deployment";

// Inputs a Compose file may also set, with the setting each one maps to
const stackSettings: Record<
  string,
  {
    key: keyof Settings;
    parse: (value: unknown) => unknown;
    expected: string;
  }
> = {
  "env-var-prefix": {
    key: "envVarPrefix",
    parse: (value) =>
      typeof value === "string" && value ? value.replace(/_$/, "") : undefined,
    expected: "a non-empty string",
  },
  "health-check-warnings": {
    key: "healthCheckWarnings",
    parse: parseBoolean,
    expected: "true or false",
  },
  "key-interpolation": {
    key: "keyInterpolation",
    parse: parseBoolean,
    expected: "true or false",
  },
  "manage-variables": {
    key: "manageVariables",
    parse: parseBoolean,
    expected: "true or false",
  },
  monitor: { key: "monitor", parse: parseBoolean, expected: "true or false" },
  "monitor-interval": {
    key: "monitorInterval",
    parse: parseSeconds,
    expected: "a positive whole number of seconds",
  },
  "monitor-timeout": {
    key: "monitorTimeout",
    parse: parseSeconds,
    expected: "a positive whole number of seconds",
  },
  "strict-compatibility": {
    key: "strictCompatibility",
    parse: parseBoolean,
    expected: "true or false",
  },
  "strict-variables": {
    key: "strictVariables",
    parse: parseBoolean,
    expected: "true or false",
  },
};

/**
 * Apply the settings block of the Compose files
 *
 * A setting given as a workflow input wins over the Compose file, which wins
 * over the default. Every value is validated, including overridden ones, so
 * a mistake in the file surfaces in every environment that deploys it.
 *
 * @param settings Settings parsed from the inputs
 * @param block Merged settings block of the Compose files
 * @returns A copy of the settings with the block applied
 */
export function applyStackSettings<T extends Settings>(
  settings: T,
  block: Readonly<Record<string, unknown>>,
): T {
  const resolved = { ...settings };

  for (const [name, value] of Object.entries(block)) {
    const setting = stackSettings[name];

    if (!setting) {
      warning(
        `Ignoring unknown setting "${name}" in "${stackSettingsKey}". ` +
          `Supported settings: ${Object.keys(stackSettings).join(", ")}.`,
      );
      continue;
    }

    const parsed = setting.parse(value);

    if (parsed === undefined) {
      throw new Error(
        `The "${name}" setting in "${stackSettingsKey}" must be ` +
          `${setting.expected}, but is "${value}".`,
      );
    }

    if (settings.explicitInputs?.has(name)) {
      info(
        `The "${name}" input overrides the "${name}" setting in ` +
          `"${stackSettingsKey}"`,
      );
      continue;
    }

    Object.assign(resolved, { [setting.key]: parsed });
  }

  return resolved;
}

/**
 * Parse settings from GitHub Actions inputs
 */
export function parseSettings(env: NodeJS.ProcessEnv) {
  debug("Parsing settings from inputs");

  const stack = inferStackName(getInput("stack-name"), env);
  const version = inferVersion(getInput("version"), env);
  const { variables, secretValues } = inferVariables(
    {
      variables: getInput("variables"),
      secrets: getInput("secrets"),
      excludeVariables: getInput("exclude-variables"),
      extraVariables: getInput("extra-variables"),
    },
    env,
  );

  // Add deployment variables that should be available during interpolation
  variables.set("MATCHORY_DEPLOYMENT_STACK", stack);
  variables.set("MATCHORY_DEPLOYMENT_VERSION", version);

  // Inputs a Compose file may also set have no default in action.yml, so an
  // unset one can be told apart from one set to its default value.
  const explicitInputs = new Set<string>();
  const optionalBooleanInput = (name: string) => {
    const value = getOptionalBooleanInput(name);

    if (value !== undefined) {
      explicitInputs.add(name);
    }

    return value;
  };
  const optionalInput = (name: string) => {
    const value = getInput(name);

    if (value) {
      explicitInputs.add(name);
    }

    return value;
  };

  const healthCheckWarnings =
    optionalBooleanInput("health-check-warnings") ?? true;
  const keyInterpolation = optionalBooleanInput("key-interpolation") ?? false;
  const manageVariables = optionalBooleanInput("manage-variables") ?? true;
  const monitor = optionalBooleanInput("monitor") ?? false;
  const strictCompatibility =
    optionalBooleanInput("strict-compatibility") ?? false;
  const strictVariables = optionalBooleanInput("strict-variables") ?? true;
  const uploadComposeSpec =
    getBooleanInput("upload-compose-spec", { required: false }) ?? true;

  return defineSettings({
    composeFiles: inferComposeFiles(getInput("compose-file"), env),
    deploymentLabels: inferDeploymentLabels(version, env),
    envVarPrefix: (optionalInput("env-var-prefix") || "DEPLOYMENT").replace(
      /_$/,
      "",
    ),
    explicitInputs,
    healthCheckWarnings,
    keyInterpolation,
    manageVariables,
    monitor,
    monitorInterval: parsePositiveSeconds(
      optionalInput("monitor-interval"),
      "monitor-interval",
      5,
      monitor,
    ),
    monitorTimeout: parsePositiveSeconds(
      optionalInput("monitor-timeout"),
      "monitor-timeout",
      300,
      monitor,
    ),
    secretValues,
    stack,
    strictCompatibility,
    strictVariables,
    uploadComposeSpec,
    variables,
    version,
  });
}

// Read a boolean input that has no default. getBooleanInput rejects the empty
// string an unset input reads as, so that case is told apart afterwards;
// any other value it rejects is a genuine mistake.
function getOptionalBooleanInput(name: string): boolean | undefined {
  try {
    return getBooleanInput(name);
  } catch (error) {
    if (!getInput(name)) {
      return undefined;
    }

    throw error;
  }
}

// Parse a whole-second duration input. An unset input falls back to the
// default; a non-numeric or non-positive value is rejected up front, because a
// NaN interval/timeout would otherwise make the monitor loop hang silently
// (`elapsed >= NaN` is always false) with no indication of why.
// Rejecting only applies when monitoring is enabled, since the value is never
// read otherwise: failing on an unused input would break existing workflows
// that already pass one.
function parsePositiveSeconds(
  raw: string,
  input: string,
  fallback: number,
  monitor: boolean,
): number {
  if (!raw) {
    return fallback;
  }

  // Only plain digits are accepted. `Number.parseInt` would silently truncate
  // instead of rejecting: it reads "5.9" as 5, "10s" as 10, and "1e3" as 1 --
  // a thousandth of the duration the author asked for.
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isInteger(value) || value <= 0) {
    if (!monitor) {
      return fallback;
    }

    throw new Error(
      `The "${input}" input must be a positive whole number of seconds, ` +
        `but received "${raw}".`,
    );
  }

  return value;
}

function inferStackName(name: string | undefined, env: NodeJS.ProcessEnv) {
  return name || env.GITHUB_REPOSITORY?.split("/")?.pop() || "unknown";
}

function inferVersion(version: string | undefined, env: NodeJS.ProcessEnv) {
  if (version) {
    return version;
  }

  if (env.GITHUB_REF?.startsWith("refs/tags/")) {
    return env.GITHUB_REF.replace("refs/tags/", "");
  }

  return env.GITHUB_SHA?.substring(0, 7) ?? "unknown";
}

function inferComposeFiles(files: string | undefined, env: NodeJS.ProcessEnv) {
  const composeFiles = files || env.COMPOSE_FILE;

  // If input contains newlines and no custom separator is set, use newline as separator
  const hasCustomSeparator = env.COMPOSE_PATH_SEPARATOR !== undefined;
  const hasNewlines = composeFiles?.includes("\n") ?? false;
  const separator =
    hasNewlines && !hasCustomSeparator
      ? "\n"
      : env.COMPOSE_PATH_SEPARATOR || ":";

  return (composeFiles?.split(separator) ?? [])
    .map((file) => file.trim())
    .filter(Boolean);
}

interface VariableInputs {
  variables?: string;
  secrets?: string;
  excludeVariables?: string;
  extraVariables?: string;
}

function inferVariables(inputs: VariableInputs, env: NodeJS.ProcessEnv) {
  const variables = new Map<string, string>();

  // Step 1: Read environment variables from the process environment as defaults
  for (const [key, content] of Object.entries(env)) {
    if (key === "VARIABLES") {
      continue;
    }

    if (content) {
      variables.set(key, content);
    }
  }

  // Step 2: Parse and merge variables from the variables input
  if (inputs.variables) {
    const parsedVariables = parseVariableInput(inputs.variables);
    for (const [key, value] of parsedVariables) {
      variables.set(key, value);
    }
  }

  // Step 3: Parse and merge secrets (higher priority than variables)
  const parsedSecrets = parseVariableInput(inputs.secrets ?? "");

  for (const [key, value] of parsedSecrets) {
    // Ensure secrets are masked in output
    if (value) {
      setSecret(value);
    }

    variables.set(key, value);
  }

  // Step 4: Apply exclusions (before extra variables to ensure they have highest priority)
  if (inputs.excludeVariables) {
    const excludeList = inputs.excludeVariables
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const key of excludeList) {
      variables.delete(key);
    }
  }

  // Step 5: Parse and merge extra variables (highest priority, cannot be excluded)
  if (inputs.extraVariables) {
    const parsedExtraVariables = parseVariableInput(inputs.extraVariables);
    for (const [key, value] of parsedExtraVariables) {
      variables.set(key, value);
    }
  }

  // Derived last, so it cannot disagree with `variables`: exclusions can drop a
  // secret's name, and extra-variables can overwrite its value with one that is
  // not secret. Either way the name no longer resolves to a secret value, and
  // redacting it would rewrite something that is not sensitive.
  const secretValues = new Map(
    [...parsedSecrets].filter(
      ([key, value]) => value && variables.get(key) === value,
    ),
  );

  return { variables, secretValues };
}

function parseVariableInput(input: string): Map<string, string> {
  const variables = new Map<string, string>();

  if (!input) {
    return variables;
  }

  const trimmedInput = input.trim();

  // Try to parse as JSON first
  if (isJsonLike(trimmedInput)) {
    try {
      const parsed = JSON.parse(trimmedInput);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            variables.set(key, value);
          } else if (value !== null && value !== undefined) {
            variables.set(key, String(value));
          }
        }
        return variables;
      }
    } catch {
      // If JSON parsing fails, fall through to KEY=VALUE parsing
    }
  }

  // Parse as KEY=VALUE format with HEREDOC support
  const lines = input.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }

    // Check for HEREDOC syntax: KEY<<DELIMITER
    const heredocMatch = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)<<([A-Za-z0-9_]+)$/,
    );

    if (heredocMatch) {
      const [, key, delimiter] = heredocMatch;
      const contentLines: string[] = [];

      // Move to the next line after the HEREDOC declaration
      i++;

      // Collect lines until we find the delimiter
      while (i < lines.length) {
        if (lines[i] === delimiter) {
          // Found the closing delimiter
          break;
        }

        contentLines.push(lines[i]);
        i++;
      }

      variables.set(key, contentLines.join("\n"));

      // Skip the delimiter line
      i++;
    } else {
      // Traditional key=value format: only the first `=` separates the key,
      // and the value is kept exactly as written, including its whitespace,
      // but without the carriage return of a CRLF line ending
      const entry = lines[i].replace(/\r$/, "");
      const separator = entry.indexOf("=");

      if (separator === -1) {
        variables.set(line, "");
      } else {
        variables.set(
          entry.slice(0, separator).trim(),
          entry.slice(separator + 1),
        );
      }

      i++;
    }
  }

  return variables;
}

function isJsonLike(input: string): boolean {
  // Quick check to avoid expensive JSON.parse calls for obviously non-JSON strings
  if (!input.startsWith("{") || !input.endsWith("}")) {
    return false;
  }

  // Additional heuristics to filter out common false positives
  // If it contains KEY= patterns without proper JSON structure, likely KEY=VALUE format
  if (input.includes("=") && !input.includes(":")) {
    return false;
  }

  return true;
}
