import { getBooleanInput, getInput } from "@actions/core";
import { env } from "node:process";
import { debug } from "node:util";

/**
 * Deployment settings
 */
export interface Settings {
  stack: string;
  version: string;
  composeFiles?: string[];
  envVarPrefix: string;
  strictVariables: boolean;
  manageVariables: boolean;
  monitor: boolean;
  monitorTimeout: number;
  monitorInterval: number;
}

export function defineSettings<T extends Settings>(settings: T) {
  return settings;
}

/**
 * Parse settings from GitHub Actions inputs
 */
export function parseSettings(env: NodeJS.ProcessEnv) {
  debug("Parsing settings from inputs");

  return defineSettings({
    composeFiles: inferComposeFiles(getInput("compose-file"), env),
    envVarPrefix: (getInput("env-var-prefix") || "DEPLOYMENT").replace(
      /_$/,
      "",
    ),
    strictVariables:
      getBooleanInput("strict-variables", { required: false }) ?? false,
    manageVariables:
      getBooleanInput("manage-variables", { required: false }) ?? true,
    monitor: getBooleanInput("monitor", { required: false }) ?? false,
    monitorTimeout: parseInt(getInput("monitor-timeout") || "300", 10),
    monitorInterval: parseInt(getInput("monitor-interval") || "5", 10),
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
