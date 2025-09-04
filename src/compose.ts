import * as core from "@actions/core";
import { dump, load } from "js-yaml";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { debug } from "node:util";
import { join } from "path";
import { normalizeStackSpecification } from "./engine";
import type { Settings } from "./settings.js";
import { exists, findFirstExistingFile, interpolateString } from "./utils.js";
import { processVariable, type Variable } from "./variables.js";

export const schemaVersion = "3.9";

export const defaultVariants = [
  "compose.production.yaml",
  "compose.production.yml",
  "compose.prod.yaml",
  "compose.prod.yml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.production.yaml",
  "docker-compose.production.yml",
  "docker-compose.prod.yaml",
  "docker-compose.prod.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  join(".docker", "compose.yaml"),
  join(".docker", "compose.yml"),
  join(".docker", "docker-compose.yaml"),
  join(".docker", "docker-compose.yml"),
  join("docker", "compose.yaml"),
  join("docker", "compose.yml"),
  join("docker", "docker-compose.yaml"),
  join("docker", "docker-compose.yml"),
] as const;

/**
 * Resolves the Docker Compose File path
 *
 * This function checks if the user has specified any Compose Files explicitly
 * in the settings. If so, it checks if those files exist and are readable.
 * If any of the specified files are missing, it throws an error and aborts
 * the deployment.
 * If no Compose Files are specified, it checks common default locations
 * for the Compose File to deploy, using the first one it finds.
 * If neither the specified nor the default Compose Files are found, it throws
 * an error and aborts the deployment.
 */
export async function resolveComposeFiles(
  settings: Readonly<Settings>,
): Promise<readonly [string, ...string[]]> {
  debug(`Resolving Compose File from ${settings.composeFiles}`);

  // If the user has specified any Compose Files explicitly, we check those and
  // bail if any is missing. This avoids accidentally deploying a stack with
  // the wrong Compose File; e.g., if the config file specifies
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

  // If no Compose Files are specified, we check several default locations for
  // the Compose File to deploy, using the first one we find. This allows users
  // to use the action without having to specify a Compose File, as long as they
  // follow the naming conventions outlined in the documentation.
  const foundFile = await findFirstExistingFile(defaultVariants);

  if (foundFile) {
    core.info(`Found Compose File at "${foundFile}"`);
    return [foundFile] as const;
  }

  // We couldn't find any Compose Files, so we throw an error and abort the
  // deployment early.
  throw new Error("Could not find suitable Compose File");
}

/**
 * Loads and normalizes the Compose specification
 *
 * This function loads the Compose specification(s) from all specified or
 * discovered Compose Files, reconciles the specification to the legacy Compose
 * file version 3 format, and resolves all referenced variables.
 * It returns a set of normalized Compose specification objects that will be
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
 * Adapt a Compose specification to Compose File version 3
 *
 * The docker stack deploy command uses the legacy [Compose File version
 * 3](https://docs.docker.com/reference/compose-file/legacy-versions/) format,
 * used by Compose V1. The latest format, defined by the
 * [Compose specification](https://docs.docker.com/reference/compose-file/)
 * isn't compatible with the docker stack deploy command.
 *
 * @param composeSpec The Compose specification to adapt
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

  if (settings.manageVariables) {
    if (composeSpec.secrets) {
      core.startGroup("Processing secrets");

      for (const [name, entry] of Object.entries(composeSpec.secrets)) {
        composeSpec.secrets[name] = await processVariable(
          name,
          entry,
          settings,
        );
      }

      core.endGroup();
    }

    if (composeSpec.configs) {
      core.startGroup("Processing configs");

      for (const [name, entry] of Object.entries(composeSpec.configs)) {
        composeSpec.configs[name] = await processVariable(
          name,
          entry,
          settings,
        );
      }

      core.endGroup();
    }
  }

  return composeSpec;
}

/**
 * Normalize the Compose specification
 *
 * This function takes multiple Compose specifications and merges them into a
 * single configuration. This works by delegating the merging to the `docker
 * stack config` command, which will:
 *  - validate the Compose Files according to the docker stack specification,
 *  - merge them into a single, canonical configuration object, and
 *  - resolve all shorthand options to their full form.
 *
 * This process allows users to write Compose Spec files—which would normally
 * not be compatible with the stack specification—while still being able
 * to deploy them to Swarm.
 *
 * @param composeSpecs The Compose specifications to normalize
 * @param settings The settings to use for the deployment
 */
export async function normalizeSpec(
  composeSpecs: ComposeSpec[],
  settings: Readonly<Settings>,
) {
  // As we possibly have modified the Compose specs read from the input files,
  // we need to write them out to temporary files, so we can rely on the docker
  // stack config command to merge them correctly.
  const composeFiles = await Promise.all(
    composeSpecs.map(async (spec) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec));

      return file;
    }),
  );

  let spec;

  try {
    spec = await normalizeStackSpecification(composeFiles, settings, true);
  } finally {
    // Remove the temporary files again, regardless of the exit code.
    await Promise.all(composeFiles.map((path) => unlink(path)));
  }

  if (!spec?.services || Object.keys(spec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }

  return spec;
}

/**
 * Interpolate variables in the Compose specification
 *
 * This function interpolates variables in the Compose specification, following
 * the Compose Spec interpolation rules, with an optional exception: While
 * Compose does not support interpolation of variables within keys, this can be
 * optionally enabled by the `keyInterpolation` setting.
 * This means that `$FOO: $BAR` will be replaced with `foo: bar` if enabled,
 * while it would remain as `$FOO: bar` if disabled, leaving the key untouched.
 *
 * @param composeSpec The Compose specification to interpolate
 * @param keyInterpolation Whether to interpolate variables in keys
 * @param variables The variables to use for interpolation
 */
export function interpolateSpec(
  composeSpec: ComposeSpec,
  {
    keyInterpolation,
    variables,
  }: Pick<Readonly<Settings>, "variables" | "keyInterpolation">,
) {
  const spec = keyInterpolation
    ? interpolateString(JSON.stringify(composeSpec), variables)
    : JSON.stringify(composeSpec, (_, value) =>
        typeof value === "string" ? interpolateString(value, variables) : value,
      );

  return JSON.parse(spec) as ComposeSpec;
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
