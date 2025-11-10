import { debug } from "node:util";
import { getBooleanInput, getInput } from "@actions/core";

/**
 * Deployment settings
 */
export interface Settings {
  composeFiles?: string[];
  envVarPrefix: string;
  keyInterpolation: boolean;
  manageVariables: boolean;
  monitor: boolean;
  monitorInterval: number;
  monitorTimeout: number;
  stack: string;
  strictVariables: boolean;
  variables: Map<string, string>;
  version: string;
}

export function defineSettings<T extends Settings>(settings: T) {
  return settings;
}

/**
 * Parse settings from GitHub Actions inputs
 */
export function parseSettings(env: NodeJS.ProcessEnv) {
  debug("Parsing settings from inputs");

  const stack = inferStackName(getInput("stack-name"), env);
  const version = inferVersion(getInput("version"), env);
  const variables = inferVariables(
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

  return defineSettings({
    composeFiles: inferComposeFiles(getInput("compose-file"), env),
    envVarPrefix: (getInput("env-var-prefix") || "DEPLOYMENT").replace(
      /_$/,
      "",
    ),
    keyInterpolation:
      getBooleanInput("key-interpolation", { required: false }) ?? false,
    manageVariables:
      getBooleanInput("manage-variables", { required: false }) ?? true,
    monitor: getBooleanInput("monitor", { required: false }) ?? false,
    monitorInterval: parseInt(getInput("monitor-interval") || "5", 10),
    monitorTimeout: parseInt(getInput("monitor-timeout") || "300", 10),
    stack,
    strictVariables:
      getBooleanInput("strict-variables", { required: false }) ?? false,
    variables,
    version,
  });
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
  if (inputs.secrets) {
    const parsedSecrets = parseVariableInput(inputs.secrets);
    for (const [key, value] of parsedSecrets) {
      variables.set(key, value);
    }
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

  return variables;
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
      // Traditional key=value format
      const [key, ...parts] = line.split("=").map((part) => part.trim());
      variables.set(key, parts.join("="));
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
