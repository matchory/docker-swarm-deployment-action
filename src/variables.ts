import * as core from "@actions/core";
import { createHash } from "crypto";
import * as crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ComposeSpec } from "./compose.js";
import { listConfigs, listSecrets, removeConfig, removeSecret } from "./engine";
import type { Settings } from "./settings.js";
import { exists, interpolateString } from "./utils.js";

export const nameLabel = "com.matchory.deployment.name";
export const hashLabel = "com.matchory.deployment.hash";
export const stackLabel = "com.matchory.deployment.stack";
export const versionLabel = "com.matchory.deployment.version";
export const encodeLabel = "com.matchory.deployment.encode";
export const decodeLabel = "com.matchory.deployment.decode";
export const ignoreLabel = "com.matchory.deployment.ignore";

/**
 * Process a variable (secret or config)
 */
export async function processVariable(
  name: string,
  variable: Variable | null,
  {
    envVarPrefix,
    strictVariables,
    stack,
    variables,
    version,
  }: Pick<
    Settings,
    "envVarPrefix" | "strictVariables" | "stack" | "variables" | "version"
  >,
): Promise<Variable> {
  core.debug(`Processing variable ${name}`);

  if (variable?.labels?.[ignoreLabel] === "true") {
    core.debug(`Variable "${name}" is marked as ignored. Skipping.`);

    return variable;
  }

  if (variable === null) {
    variable = {};
  }

  let modifiedVariable: FileVariable | undefined = undefined;
  let content: string | undefined = undefined;

  // If a variable names a file explicitly, we need to check if the file exists.
  if ("file" in variable) {
    try {
      content = await readFromFile(name, variable);
    } catch (error) {
      if (strictVariables) {
        throw error;
      }
    }
  } else if ("environment" in variable) {
    content = readFromEnvironment(name, variable, variables);
    modifiedVariable = await transformVariable(content, name, variable);
  } else if ("content" in variable) {
    content = readFromContent(name, variable, variables);
    modifiedVariable = await transformVariable(content, name, variable);
  }

  if (content === undefined) {
    [content, modifiedVariable] = await inferVariable(name, variable, {
      envVarPrefix,
      stack,
      variables,
    });
  }

  if (!content) {
    core.warning(
      `Variable "${name}" is defined with an empty value. This is ` +
        `not recommended, as it may lead to unexpected behavior.`,
    );
  }

  // If the variable specifies an encoding format, we need to encode or decode
  // the content accordingly. This is useful for secrets that need to be passed
  // as environment variables or in a specific format.
  if (variable.labels && encodeLabel in variable.labels) {
    content = await encodeVariable(content, name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  } else if (variable.labels && decodeLabel in variable.labels) {
    content = await decodeVariable(content, name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  }

  // Calculate hash of the variable value. If the value didn't change since the
  // last deployment, the hash will be the same, and we can reuse the existing
  // secret or config. This avoids unnecessary updates and restarts of the
  // services depending on the variable.
  const hash = hashVariable(content);
  const variableName =
    modifiedVariable?.name ?? variable.name ?? `${stack}-${name}`;

  return {
    ...(modifiedVariable ?? variable),
    name: `${variableName}-${hash.substring(0, 7)}`,
    labels: {
      ...(modifiedVariable?.labels ?? variable.labels),
      [nameLabel]: name,
      [hashLabel]: hash,
      [stackLabel]: stack,
      [versionLabel]: version,
    } as Record<string, string>,
  };
}

// region Content Loading
async function readFromFile(name: string, variable: FileVariable) {
  const filePath = variable.file;

  if (!(await exists(filePath))) {
    throw new Error(
      `Variable "${name}" specifies the file "${filePath}" as its ` +
        `source, but this file does not exist or is not readable. Ensure ` +
        `it exists, or remove the "file" property from the variable ` +
        `definition to let the action read the value from the build ` +
        `environment automatically.`,
    );
  }

  core.debug(`Loading variable ${name} from file: ${filePath}`);

  return await readFile(filePath, "utf8");
}

function readFromEnvironment(
  name: string,
  { environment: variable }: EnvironmentVariable,
  variables: Map<string, string>,
) {
  if (!variables.has(variable)) {
    throw new Error(
      `Variable "${name}" specifies the environment variable ` +
        `"${variable}" as its source, but there is no such ` +
        "variable defined in the environment. Ensure it exists, or remove " +
        `the "environment" property from the variable definition to let ` +
        "the action infer the value from the variable name automatically.",
    );
  }

  return String(variables.get(variable));
}

/**
 * Note that the `content` prop is currently part of the Compose Specification
 * but not supported by Swarm. At this point, though, the Compose File(s) have
 * already been validated by the docker stack parser, so we can be reasonably
 * sure this has changed and assume if we've got a content value, it's valid
 * by now.
 */
function readFromContent(
  _name: string,
  { content }: ContentVariable,
  variables: Map<string, string>,
) {
  // Interpolate variables within the inline content
  return interpolateString(String(content), variables);
}

async function inferVariable(
  name: string,
  variable: BaseVariable,
  {
    envVarPrefix,
    stack,
    variables,
  }: Pick<Settings, "envVarPrefix" | "stack" | "variables">,
): Promise<[string, FileVariable]> {
  const filePath = `./${name}.secret`;

  // If the variable doesn't specify a source, we need to check if it exists;
  // first as a file, then as an environment variable in several variants.
  if (await exists(filePath)) {
    core.debug(`Loading variable "${name}" from file: "${filePath}"`);

    return [
      await readFile(filePath, "utf8"),
      { ...variable, file: filePath },
    ] as const;
  }

  // Attempt to read the variable from the environment using several variants.
  // This allows translating Config names like "log-driver" to "LOG_DRIVER"
  // or "APP_LOG_DRIVER" automatically.
  const safeName = name.replace(/-/g, "_");
  const variantUpper = safeName.toUpperCase();

  for (const variant of [
    safeName,
    variantUpper,
    `${envVarPrefix}_${safeName}`,
    `${envVarPrefix}_${variantUpper}`,
    `${stack}_${safeName}`,
    `${stack}_${safeName}`.toUpperCase(),
  ]) {
    if (variables.has(variant)) {
      core.debug(
        `Loading variable "${name}" from environment variable "${variant}"`,
      );

      (variable as EnvironmentVariable).environment = variant;
      const value = variables.get(variant)!;

      return [
        value,
        await transformVariable(value, name, variable),
      ] as const;
    }
  }

  throw new Error(
    `Variable "${name}" is not defined in the environment. To ` +
      `use it as a secret or config, please set the environment variable ` +
      `"${variantUpper}" or "${envVarPrefix}_${variantUpper}", or create a ` +
      `file named "${name}.secret" in the project root directory.`,
  );
}

// endregion

// region Encoding/Decoding
const encoders = {
  base64: (value) => Buffer.from(value, "utf8").toString("base64"),
  base64url: (value) => Buffer.from(value, "utf8").toString("base64url"),
  hex: (value) => Buffer.from(value, "utf8").toString("hex"),
  url: (value) => encodeURIComponent(value),
} satisfies Record<string, (value: string) => string>;
const decoders = {
  base64: (value) => Buffer.from(value, "base64").toString("utf8"),
  base64url: (value) => Buffer.from(value, "base64url").toString("utf8"),
  hex: (value) => Buffer.from(value, "hex").toString("utf8"),
  url: (value) => decodeURIComponent(value),
} satisfies Record<string, (value: string) => string>;

async function encodeVariable(
  content: string,
  name: string,
  variable: Variable,
) {
  const format = variable.labels![
    encodeLabel
  ].toString() as keyof typeof encoders;

  if (!encoders[format]) {
    const supported = Object.keys(encoders).join(", ");

    throw new Error(
      `Variable "${name}" specifies an unknown encoding format: ` +
        `"${format}". Must be one of "${supported}".`,
    );
  }

  core.debug(`Encoding variable "${name}" to ${format}`);

  return encoders[format](content);
}

async function decodeVariable(
  content: string,
  name: string,
  variable: Variable,
) {
  const format = variable.labels![
    decodeLabel
  ].toString() as keyof typeof decoders;

  if (!decoders[format]) {
    const supported = Object.keys(decoders).join(", ");

    throw new Error(
      `Variable "${name}" specifies an unknown decoding format: ` +
        `"${format}". Must be one of "${supported}".`,
    );
  }

  core.debug(`Decoding variable "${name}" from ${format}`);

  return decoders[format](content);
}

async function transformVariable(
  value: string,
  name: string,
  variable: Variable,
): Promise<FileVariable> {
  // Generate a random file name for the secret, so it doesn't conflict with
  // existing files in the repository
  const path = `./${name}.${crypto.randomUUID()}.generated.secret`;

  await writeFile(path, value, "utf8");

  // Remove the existing value pointer from the variable to avoid multiple
  // source definition errors during the actual deployment
  delete (variable as Partial<EnvironmentVariable>).environment;
  delete (variable as Partial<ContentVariable>).content;

  // Overwrite the variable with the new secret file path, so the docker CLI
  // will use it instead of the original value
  return {
    ...variable,
    file: path,
    labels: {
      ...variable.labels,
    },
  };
}

// endregion

// region Pruning
/**
 * Prune outdated variables (secrets and configs)
 */
export async function pruneVariables(
  composeSpec: ComposeSpec,
  settings: Readonly<Settings>,
) {
  core.startGroup("Pruning outdated variables");

  await pruneSecrets(composeSpec, settings);
  await pruneConfigs(composeSpec, settings);

  core.endGroup();
}

/**
 * Prune outdated secrets
 */
export async function pruneSecrets(
  { secrets }: ComposeSpec,
  { stack }: Settings,
) {
  core.debug(`Pruning secrets for stack "${stack}"`);

  const variableIdentifier = ({
    stack,
    name,
    hash,
  }: {
    stack: string;
    name: string;
    hash: string;
  }) => stack + name + hash;
  const specSecrets = secrets
    ? Object.values(secrets)
        .map(({ labels }) => marshalLabels(labels))
        .filter((labels) => labels !== undefined)
        .map((labels) => variableIdentifier(labels))
    : [];

  const items = await listSecrets({
    labels: {
      stackLabel: stack,
    },
  });

  if (items.length == 0) {
    return;
  }

  core.info(
    `Checking ${items.length} secret${items.length !== 1 ? "s" : ""} ` +
      `for stack "${stack}"`,
  );

  for (let i = 0; i < items.length; i++) {
    const { CreatedAt, ID, Name, Labels } = items[i];

    const name = Name ?? ID;
    const labels = marshalLabels(Labels);

    core.debug(`Checking secret ${i + 1}/${items.length}: ${name}`);

    if (!labels) {
      core.notice(`Found invalid secret "${name}": Missing labels. Pruning.`);

      await removeSecret(ID);
      continue;
    }

    if (!specSecrets.includes(variableIdentifier(labels))) {
      const hash = labels.hash.substring(0, 7);

      core.notice(
        `Pruning outdated version "${hash}" of secret "${labels.name}": ${name}`,
      );

      await removeSecret(ID);
    }

    // Check for old secrets
    if (shouldRotate(new Date(CreatedAt ?? 0))) {
      core.warning(
        `Secret "${name}" has been in use for too long and should be rotated!`,
      );
    }
  }
}

/**
 * Prune outdated configs
 */
export async function pruneConfigs(
  { configs }: ComposeSpec,
  { stack }: Settings,
) {
  core.debug(`Pruning configs for stack "${stack}"`);

  const variableIdentifier = ({
    stack,
    name,
    hash,
  }: {
    stack: string;
    name: string;
    hash: string;
  }) => stack + name + hash;
  const specConfigs = configs
    ? Object.values(configs)
        .map(({ labels }) => marshalLabels(labels))
        .filter((labels) => labels !== undefined)
        .map((labels) => variableIdentifier(labels))
    : [];

  const items = await listConfigs({
    labels: {
      stackLabel: stack,
    },
  });

  if (items.length == 0) {
    return;
  }

  core.info(
    `Checking ${items.length} config${items.length !== 1 ? "s" : ""} ` +
      `for stack "${stack}"`,
  );

  for (let i = 0; i < items.length; i++) {
    const { ID, Name, Labels } = items[i];

    const name = Name ?? ID;
    const labels = marshalLabels(Labels);

    core.debug(`Checking config ${i + 1}/${items.length}: ${name}`);

    if (!labels) {
      core.notice(
        `Found invalid config "${name}": Missing variable labels. Pruning.}`,
      );

      await removeConfig(ID);
      continue;
    }

    if (!specConfigs.includes(variableIdentifier(labels))) {
      const hash = labels.hash.substring(0, 7);

      core.notice(
        `Pruning outdated version "${hash}" of config "${labels.name}": ${name}`,
      );

      await removeConfig(ID);
    }
  }
}

// endregion

// region Helpers
export function defineVariable<T extends Variable>(variable: T) {
  return variable;
}

export function hashVariable(value: string) {
  return createHash("sha256").update(value.trim()).digest("hex");
}

function marshalLabels(labels: Record<string, string | number> | undefined) {
  const name = labels?.[nameLabel];
  const hash = labels?.[hashLabel];
  const stack = labels?.[stackLabel];
  const version = labels?.[versionLabel];

  if (!name || !hash || !stack || !version) {
    return undefined;
  }

  return {
    name: String(name),
    hash: String(hash),
    stack: String(stack),
    version: String(version),
  };
}

function shouldRotate(createdAt: Date) {
  const oneYearAgo = new Date();
  oneYearAgo.setDate(oneYearAgo.getDate() - 365);
  return createdAt < oneYearAgo;
}

// endregion

type BaseVariable = {
  name?: string;
  labels?: Record<string, string | number>;
  driver?: string;
  driver_opts?: Record<string, string | number>;
  external?: boolean | string | { name: string };
  template_driver?: string;
};
type FileVariable = BaseVariable & { file: string };
type ContentVariable = BaseVariable & { content: string };
type EnvironmentVariable = BaseVariable & { environment: string };

/**
 * Variable (secret or config) specification
 */
export type Variable =
  | BaseVariable
  | FileVariable
  | ContentVariable
  | EnvironmentVariable;
