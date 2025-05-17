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
export function parseSettings() {
  debug("Parsing settings from inputs");

  return defineSettings({
    stack: inferStackName(getInput("stack-name")),
    version: inferVersion(getInput("version")),
    composeFiles: inferComposeFiles(getInput("compose-file")),
    envVarPrefix: (getInput("env-var-prefix") || "DEPLOYMENT").replace(
      /_$/,
      "",
    ),
    strictVariables:
      getBooleanInput("strict-variables", { required: false }) ?? false,
    monitor: getBooleanInput("monitor", { required: false }) ?? false,
    monitorTimeout: parseInt(getInput("monitor-timeout") || "300", 10),
    monitorInterval: parseInt(getInput("monitor-interval") || "5", 10),
  });
}

function inferStackName(name: string | undefined) {
  return name || env.GITHUB_REPOSITORY?.split("/")?.pop() || "unknown";
}

function inferVersion(version: string | undefined) {
  if (version) {
    return version;
  }

  if (env.GITHUB_REF?.startsWith("refs/tags/")) {
    return env.GITHUB_REF.replace("refs/tags/", "");
  }

  return env.GITHUB_SHA?.substring(0, 7) ?? "unknown";
}

function inferComposeFiles(files?: string) {
  const composeFiles = files ?? env.COMPOSE_FILE;
  const separator = env.COMPOSE_PATH_SEPARATOR || ":";

  return (composeFiles?.split(separator) ?? [])
    .map((file) => file.trim())
    .filter(Boolean);
}
