import { getBooleanInput, getInput } from "@actions/core";
import { debug } from "node:util";

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
  const variables = inferVariables(getInput("variables"), env);

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
  const separator = env.COMPOSE_PATH_SEPARATOR || ":";

  return (composeFiles?.split(separator) ?? [])
    .map((file) => file.trim())
    .filter(Boolean);
}

function inferVariables(input: string | undefined, env: NodeJS.ProcessEnv) {
  const variables = new Map<string, string>();

  // Read environment variables from the process environment as defaults
  for (const [key, content] of Object.entries(env)) {
    if (key === "VARIABLES") {
      continue;
    }

    if (content) {
      variables.set(key, content);
    }
  }

  if (!input) {
    return variables;
  }

  // Parse input as a string of key=value pairs
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !!line && !line.startsWith("#"))
    .reduce((acc, line) => {
      const [key, ...parts] = line.split("=").map((part) => part.trim());
      const content = parts.join("=");

      return acc.set(key, content);
    }, variables);
}
