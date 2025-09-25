import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { dump, load } from "js-yaml";
import type { ComposeSpec } from "./compose.js";
import type { Settings } from "./settings.js";
import { mapToObject } from "./utils";

/**
 * Deploy the stack
 */
export async function deployStack(
  spec: ComposeSpec,
  { stack, variables }: Pick<Readonly<Settings>, "stack" | "variables">,
) {
  await executeDockerCommand(
    [
      "stack",
      "deploy",
      "--prune",
      "--quiet",
      "--detach=true",
      "--with-registry-auth",
      "--resolve-image=always",
      "--compose-file",
      "-",
      stack,
    ],
    {
      stdin: dump(spec),
      env: {
        ...mapToObject(variables),
      },
    },
  );

  core.info(`Deployed stack ${stack}`);
}

export async function normalizeComposeSpecification(
  composeFiles: string[],
  { variables }: Pick<Readonly<Settings>, "variables">,
  skipInterpolation = false,
  pinImages = false,
) {
  const composeFileFlags = composeFiles.map((file) => `--compose-file=${file}`);
  const content = await executeDockerCommand(
    [
      "compose",
      "config",
      ...composeFileFlags,
      "--format=json",
      skipInterpolation ? "--no-interpolate" : "",
      pinImages ? "--resolve-image-digests" : "",
    ],
    {
      env: {
        ...mapToObject(variables),
      },
    },
  );

  if (!content) {
    throw new Error(
      "Failed to load compose file(s): No content produced. This is " +
        "most likely a bug in the deployment action. Please report it to " +
        "the action issues.",
    );
  }

  try {
    return JSON.parse(content) as ComposeSpec | undefined;
  } catch (cause) {
    throw new Error(
      "Failed to load compose file(s): Failed to parse JSON output. " +
        "This is most likely a bug in the deployment action. Please report " +
        "it to the action issues.",
      { cause },
    );
  }
}

export async function normalizeStackSpecification(
  composeFiles: string[],
  { variables }: Pick<Readonly<Settings>, "variables">,
  skipInterpolation = false,
) {
  const composeFileFlags = composeFiles.map((file) => `--compose-file=${file}`);
  const content = await executeDockerCommand(
    [
      "stack",
      "config",
      ...composeFileFlags,
      skipInterpolation ? "--skip-interpolation" : "",
    ],
    {
      env: {
        ...mapToObject(variables),
      },
      silent: true,
    },
  );

  if (!content) {
    throw new Error(
      "Failed to load compose file(s): No content produced. This is " +
        "most likely a bug in the deployment action. Please report it to " +
        "the action issues.",
    );
  }

  let spec: ComposeSpec | undefined;

  try {
    spec = load(content, {
      filename: "docker-compose.yaml",
      json: true,
      onWarning: (error) => core.warning(error),
    }) as ComposeSpec;
  } catch (cause) {
    throw new Error(
      "Failed to load compose file(s): Failed to parse YAML output: " +
        `${cause}: This is most likely a bug in the deployment action. ` +
        "Please report it to the action issues.",
      { cause },
    );
  }

  if (!spec) {
    throw new Error(
      "Failed to load compose file(s): Failed to parse YAML output. " +
        "This is most likely a bug in the deployment action. Please report " +
        "it to the action issues.",
    );
  }

  return spec;
}

type ServiceFilters = {
  id?: ValueFilter;
  labels?: KeyValueFilter;
  mode?: ValueFilter<"replicated" | "global">;
  name?: ValueFilter;
};

export async function listServices(
  filters: ServiceFilters,
  inspect?: false,
): Promise<ServiceMetadata[]>;
export async function listServices(
  filters: ServiceFilters,
  inspect: true,
): Promise<ServiceWithMetadata[]>;
export async function listServices(
  filters: ServiceFilters,
  inspect?: boolean,
): Promise<ServiceMetadata[] | ServiceWithMetadata[]> {
  core.debug("Listing services");

  const filterFlags = buildFilters(
    {
      id: filters.id,
      label: filters.labels ? parseLabelFilter(filters.labels) : undefined,
      mode: filters.mode,
      name: filters.name,
    },
    "--filter",
  );

  try {
    const output = await executeDockerCommand(
      ["service", "ls", "--format=json", ...filterFlags],
      { silent: true },
    );
    const services = parseLineDelimitedJson<ServiceMetadata>(output);

    if (!inspect) {
      return services;
    }

    const inspectedServices: ServiceWithMetadata[] = [];

    for (const metadata of services) {
      const service = await inspectService(metadata.ID);

      inspectedServices.push({ ...metadata, ...service });
    }

    return inspectedServices;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    throw new Error(`Failed to list services: ${message}`, { cause });
  }
}

export async function inspectService(id: string) {
  const output = await executeDockerCommand(
    ["service", "inspect", "--format=json", id],
    { silent: true },
  );

  try {
    const result = JSON.parse(output) as Service | Service[];

    if (Array.isArray(result)) {
      if (result.length === 0) {
        throw new Error(`Service "${id}" not found`);
      }

      return result[0];
    }

    return result;
  } catch (cause) {
    throw new Error(
      `Failed to inspect service ${id}: Failed to parse JSON output. ` +
        "This is most likely a bug in the deployment action. Please report " +
        "it to the action issues.",
      { cause },
    );
  }
}

export async function getServiceLogs(
  id: string,
  { tail, since }: { tail?: number; since?: Date },
) {
  try {
    const output = await executeDockerCommand(
      [
        "service",
        "logs",
        "--raw",
        "--no-trunc",
        "--details",
        "--timestamps",
        tail ? `--tail=${tail}` : "",
        since ? `--since=${since.toISOString()}` : "",
        id,
      ],
      { silent: true },
    );

    return output
      .trim()
      .split("\n")
      .filter((line) => !!line?.trim())
      .map((line) => {
        const [rawTimestamp, metadata, ...rest] = line.split(" ");
        let timestamp: Date | null;

        try {
          timestamp = new Date(rawTimestamp);

          if (isNaN(timestamp.getTime())) {
            throw new Error("Invalid date");
          }
        } catch {
          core.warning(`Unexpected invalid timestamp: ${rawTimestamp}`);
          timestamp = null;
        }

        return {
          timestamp,
          metadata: parseLabels(metadata),
          message: rest.join(" "),
        };
      });
  } catch (cause) {
    throw new Error(`Failed to get logs for service "${id}": ${cause}`, {
      cause,
    });
  }
}

export async function listSecrets(filters: {
  id?: ValueFilter;
  name?: ValueFilter;
  labels?: KeyValueFilter;
}) {
  core.info("Listing secrets");

  const filterFlags = buildFilters({
    id: filters.id,
    name: filters.name,
    label: filters.labels ? parseLabelFilter(filters.labels) : undefined,
  });

  try {
    const output = await executeDockerCommand(
      ["secret", "ls", "--format=json", ...filterFlags],
      { silent: true },
    );

    return parseLineDelimitedJson<StoredVariable>(output).map<SecretMetadata>(
      (secret) => ({
        ...secret,
        Labels: parseLabels(secret.Labels ?? ""),
      }),
    );
  } catch (cause) {
    throw new Error(`Failed to list secrets: ${cause}`, { cause });
  }
}

export async function listConfigs(filters: {
  id?: ValueFilter;
  name?: ValueFilter;
  labels?: KeyValueFilter;
}) {
  core.debug("Listing configs");

  const filterFlags = buildFilters({
    id: filters.id,
    name: filters.name,
    label: filters.labels ? parseLabelFilter(filters.labels) : undefined,
  });

  try {
    const output = await executeDockerCommand(
      ["config", "ls", "--format=json", ...filterFlags],
      { silent: true },
    );

    return parseLineDelimitedJson<StoredVariable>(output).map<ConfigMetadata>(
      (config) => ({
        ...config,
        Labels: parseLabels(config.Labels ?? ""),
      }),
    );
  } catch (cause) {
    throw new Error(`Failed to list configs: ${cause}`, { cause });
  }
}

/**
 * Remove an unused secret
 *
 * This function removes a secret from the Swarm.
 *
 * @param id The ID of the secret to remove
 */
export async function removeSecret(id: string) {
  core.info(`Removing unused secret "${id}"`);

  try {
    await executeDockerCommand(["secret", "rm", id], { silent: true });
  } catch (cause) {
    throw new Error(`Failed to remove secret "${id}": ${cause}`, { cause });
  }
}

/**
 * Remove an unused config value
 *
 * This function removes a config value from the Swarm.
 *
 * @param id The ID of the config to remove
 */
export async function removeConfig(id: string) {
  core.info(`Removing unused config "${id}"`);

  try {
    await executeDockerCommand(["config", "rm", id], { silent: true });
  } catch (cause) {
    throw new Error(`Failed to remove config "${id}": ${cause}`, { cause });
  }
}

/**
 * Execute a Docker command
 *
 * This function executes a Docker command with the given arguments and options.
 * It captures the output from stdout and returns it as a string.
 *
 * @param args      The arguments to pass to the Docker command
 * @param [stdin]   Optional input to pass to the command's stdin
 * @param [env]     Optional environment variables to set for the command
 * @param [silent]  If true, suppresses the output of the command to the action
 *                  log output
 */
async function executeDockerCommand(
  args: [string, ...string[]],
  {
    stdin = undefined,
    env = undefined,
    silent = false,
  }: {
    stdin?: Buffer | string;
    env?: Record<string, string>;
    silent?: boolean;
  } = {},
) {
  const input = stdin
    ? Buffer.isBuffer(stdin)
      ? stdin
      : Buffer.from(stdin)
    : undefined;
  let output = "";
  let errorOutput = "";

  core.startGroup(`docker ${args.join(" ")}`);

  try {
    await exec(
      "docker",
      args.filter((arg) => arg !== "" && arg !== undefined),
      {
        input,
        silent,
        env,
        listeners: {
          stdout: (data) => (output += data.toString()),
          stderr: (data) => (errorOutput += data.toString()),
        },
      },
    );

    core.info(output);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    core.error(`Command failed: ${message}`);
    core.error(output);
    core.error(errorOutput);

    throw new Error(`Failed to execute Docker Command: ${message}`, { cause });
  } finally {
    core.endGroup();
  }

  return output;
}

function buildFilters<
  T extends Record<K, ValueFilter<V>>,
  K extends string = string,
  V extends string = string,
>(filters: Partial<T>, flag = "--filter") {
  return Object.entries(filters)
    .filter((filter): filter is [K, ValueFilter<V>] => Boolean(filter[1]))
    .flatMap(([name, values]) => parseFilter(name, values))
    .flatMap((value) => [flag, value] as const);
}

export function parseFilter<K extends string, V extends string>(
  name: K,
  values: V | V[],
): string[] {
  const filter = Array.isArray(values) ? values : ([values] as const);

  return filter.map((value) => `${name}=${value}` as const);
}

export function parseLabelFilter(
  labels:
    | string
    | string[]
    | { [key: string]: string }
    | Array<string | { [key: string]: string }>,
) {
  if (typeof labels === "string") {
    return [labels];
  }

  if (Array.isArray(labels)) {
    return labels.flatMap((label) => {
      if (typeof label === "string") {
        return [label];
      }

      if (typeof label === "object") {
        return Object.entries(label).map(([key, value]) => `${key}=${value}`);
      }

      return [];
    });
  }

  return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
}

function parseLineDelimitedJson<
  T extends Record<string, unknown> = Record<string, unknown>,
>(data: string): Array<T> {
  return data
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function parseLabels(labels: string = "") {
  return labels
    .split(",")
    .map((label) => {
      const [key, ...values] = label.split("=");

      return [key, values.join("=")];
    })
    .reduce<Record<string, string>>(
      (acc, [key, value]) => ({
        ...acc,
        [key]: value,
      }),
      {},
    );
}

export type ServiceMetadata = {
  ID: string;
  Name: string;
  Mode: "replicated" | "global";
  Replicas: string;
  Image: string;
  Ports: string;
};
export type Service = {
  ID: string;
  CreatedAt: Date;
  UpdatedAt: Date;
  Version: {
    Index: number;
  };
  Spec?: {
    Name: string;
    Labels: Record<string, string>;
    TaskTemplate: Record<string, unknown>;
  };
  PreviousSpec?: {
    Name: string;
    Labels: Record<string, string>;
    TaskTemplate: Record<string, unknown>;
  };
  Endpoint: Record<string, unknown>;
  UpdateStatus?: {
    StartedAt?: string | undefined;
    CompletedAt?: string | undefined;
    Message?: string | undefined;
    State:
      | "updating"
      | "paused"
      | "completed"
      | "rollback_started"
      | "rollback_paused"
      | "rollback_completed";
  };
};
export type ServiceWithMetadata = ServiceMetadata & Service;
export type SecretMetadata = {
  ID: string;
  Name: string;
  Labels: Record<string, string>;
  CreatedAt: string;
  UpdatedAt: string;
};
export type ConfigMetadata = {
  ID: string;
  Name: string;
  Labels: Record<string, string>;
  CreatedAt: string;
  UpdatedAt: string;
};

type StoredVariable = {
  ID: string;
  Name: string;
  Labels: string;
  CreatedAt: string;
  UpdatedAt: string;
};

type ValueFilter<T extends string = string> = T | T[];
type KeyValueFilter<K extends string = string, V extends string = string> =
  | ValueFilter<K>
  | Record<K, V>
  | Array<K | Record<K, V>>;
