import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { dump, load } from "js-yaml";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { debug } from "node:util";
import { join } from "path";
import type { Settings } from "./settings.js";
import { exists } from "./utils.js";
import { processVariable, type Variable } from "./variables.js";

export const schemaVersion = "3.9";

export const defaultVariants = [
  "docker-compose.production.yaml",
  "docker-compose.production.yml",
  "docker-compose.prod.yaml",
  "docker-compose.prod.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  join(".docker", "docker-compose.yaml"),
  join(".docker", "docker-compose.yml"),
  join("docker", "docker-compose.yaml"),
  join("docker", "docker-compose.yml"),
] as const;

/**
 * Resolves the Docker Compose file path
 *
 * This function checks if the user has specified any compose files explicitly
 * in the settings. If so, it checks if those files exist and are readable.
 * If any of the specified files are missing, it throws an error and aborts
 * the deployment.
 * If no compose files are specified, it checks common default locations
 * for the compose file to deploy, using the first one it finds.
 * If neither the specified nor the default compose files are found, it throws
 * an error and aborts the deployment.
 */
export async function resolveComposeFiles(
  settings: Readonly<Settings>,
): Promise<readonly [string, ...string[]]> {
  debug(`Resolving compose file from ${settings.composeFiles}`);

  // If the user has specified any compose files explicitly, we check those and
  // bail if any is missing. This avoids accidentally deploying a stack with
  // the wrong compose file; e.g. if the config file specifies
  // "docker-compose.staging.yml", but the file is actually named
  // "docker-compose.staging.yaml" (with an "a"), and there is also a production
  // config at "docker-compose.production.yaml", we would end up deploying the
  // production stack to a staging environment, possibly wreaking havoc.
  // So instead, we check if the files exist and are readable, and if not, we
  // throw an error and abort the deployment.
  if (settings.composeFiles && settings.composeFiles.length > 0) {
    const files = await Promise.all(
      settings.composeFiles.map((path) => exists(path)),
    );

    if (!files.every(Boolean)) {
      // Assemble a list of all missing files to include in the error message.
      const missing = files
        .map((exists, index) =>
          !exists ? settings.composeFiles?.[index] : undefined,
        )
        .filter((file) => file !== undefined);

      throw new Error(
        `One or more Compose Files specified in the configuration are ` +
          `missing or not readable: ${missing.join(", ")}`,
      );
    }

    // At least one file is specified
    return settings.composeFiles as [string, ...string[]];
  }

  // If no compose files are specified, we check several default locations for
  // the compose file to deploy, using the first one we find. This allows users to
  // use the action without having to specify a compose file, as long as they
  // follow the naming conventions outlined in the documentation.
  for (const location of defaultVariants) {
    if (await exists(location)) {
      core.info(`Found compose file at "${location}"`);

      return [location] as const;
    }
  }

  // We couldn't find any compose files, so we throw an error and abort the
  // deployment early.
  throw new Error("Could not find suitable compose file");
}

/**
 * Loads and normalizes the compose specification
 *
 * This function loads the compose specification(s) from all specified or
 * discovered compose files, reconciles the specification to the legacy Compose
 * file version 3 format, and resolves all referenced variables.
 * It returns a set of normalized compose specification objects that will be
 * usable to docker stack commands.
 */
export async function loadComposeSpecs(
  composeFiles: Readonly<Array<string>>,
  settings: Readonly<Settings>,
) {
  return Promise.all(
    composeFiles.map((path) => loadComposeSpec(path, settings)),
  );
}

async function loadComposeSpec(filename: string, settings: Settings) {
  const content = await readFile(filename, "utf8");
  const parsedContent = load(content, { filename }) as ComposeSpec;

  return reconcileSpec(parsedContent, settings);
}

/**
 * Adapt a compose specification to Compose file version 3
 *
 * The docker stack deploy command uses the legacy [Compose file version
 * 3](https://docs.docker.com/reference/compose-file/legacy-versions/) format,
 * used by Compose V1. The latest format, defined by the
 * [Compose specification](https://docs.docker.com/reference/compose-file/)
 * isn't compatible with the docker stack deploy command.
 *
 * @param composeSpec The compose specification to adapt
 * @param settings The settings to use for the deployment
 * @see https://docs.docker.com/engine/swarm/stack-deploy/
 * @see https://docs.docker.com/compose/intro/history/
 */
export async function reconcileSpec(
  composeSpec: ComposeSpec,
  settings: Settings,
) {
  if (composeSpec.name) {
    delete composeSpec.name;
  }

  if (!composeSpec.version) {
    composeSpec.version = schemaVersion;
  }

  if (!composeSpec.services || Object.keys(composeSpec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }

  if (composeSpec.secrets) {
    for (const [name, entry] of Object.entries(composeSpec.secrets)) {
      composeSpec.secrets[name] = await processVariable(name, entry, settings);
    }
  }

  if (composeSpec.configs) {
    for (const [name, entry] of Object.entries(composeSpec.configs)) {
      composeSpec.configs[name] = await processVariable(name, entry, settings);
    }
  }

  return composeSpec;
}

/**
 * Normalize the compose specification
 *
 * This function takes multiple compose specifications and merges them into a
 * single configuration. This works by delegating the merging to the `docker
 * stack config` command, which will:
 *  - validate the compose files according to the docker stack specification,
 *  - merge them into a single, canonical configuration object, and
 *  - resolve all shorthand options to their full form.
 *
 * This process allows users to write compose-spec files—which would normally
 * not be compatible with the stack specification—while still being able
 * to deploy them to Swarm.
 *
 * @param composeSpecs The compose specifications to normalize
 * @param _settings The settings to use for the deployment
 */
export async function normalizeComposeSpec(
  composeSpecs: ComposeSpec[],
  _settings: Readonly<Settings>,
) {
  // As we possibly have modified the compose specs read from the input files,
  // we need to write them out to temporary files, so we can rely on the docker
  // stack config command to merge them correctly.
  const composeFiles = await Promise.all(
    composeSpecs.map(async (spec) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec));

      return file;
    }),
  );

  let content = "";
  const exitCode = await exec(
    "docker",
    [
      "stack",
      "config",
      ...composeFiles.map((path) => `--compose-file=${path}`),
    ],
    {
      listeners: {
        stdout: (data) => (content += data.toString()),
      },
    },
  );

  // Remove the temporary files again, regardless of the exit code.
  await Promise.all(composeFiles.map((path) => unlink(path)));

  if (exitCode > 0) {
    throw new Error(
      `Failed to load compose file(s): Docker command failed with ` +
        `exit code [${exitCode}]. Check the logs for more details.`,
    );
  }

  if (!content) {
    throw new Error(
      "Failed to load compose file(s): No content produced. This is " +
        "most likely a bug in the deployment action. Please report it to " +
        "the action issues.",
    );
  }

  // Parse the YAML output of the `docker stack config` command, which at this
  // point is a valid docker stack specification.
  const spec = load(`${content}\n`, {
    filename: "docker-compose.yaml",
    onWarning: (error) => core.warning(error),
  }) as ComposeSpec | undefined;

  if (!spec) {
    throw new Error(
      "Failed to load compose file(s): Failed to parse YAML output. " +
        "This is most likely a bug in the deployment action. Please report " +
        "it to the action issues.",
    );
  }

  if (!spec?.services || Object.keys(spec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }

  return spec;
}

/**
 * Deploy the stack
 */
export async function deployStack(
  spec: ComposeSpec,
  settings: Readonly<Settings>,
) {
  core.startGroup("Deploying stack");

  try {
    await exec(
      "docker",
      [
        "stack",
        "deploy",
        "--prune",
        "--quiet",
        "--with-registry-auth",
        "--resolve-image",
        "always",
        "--compose-file",
        "-",
        settings.stack,
      ],
      { input: Buffer.from(dump(spec)) },
    );

    core.info(`Deployed stack ${settings.stack}`);
    core.endGroup();
  } catch (error) {
    core.endGroup();
    throw error;
  }
}

export function defineComposeSpec<T extends ComposeSpec>(spec: T) {
  return spec;
}

/**
 * Poor Man's Docker Compose specification
 */
export interface ComposeSpec {
  version?: string;
  services: Record<string, unknown>;
  secrets?: Record<string, Variable>;
  configs?: Record<string, Variable>;

  [key: string]: unknown;
}
