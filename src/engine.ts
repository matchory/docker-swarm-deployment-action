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
  {
    stack,
    variables,
    version,
  }: Pick<Readonly<Settings>, "stack" | "variables" | "version">,
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
        MATCHORY_DEPLOYMENT_STACK: stack,
        MATCHORY_DEPLOYMENT_VERSION: version,
        ...mapToObject(variables),
      },
    },
  );

  core.info(`Deployed stack ${stack}`);
}

export async function normalizeComposeSpecification(
  composeFiles: string[],
  {
    stack,
    variables,
    version,
  }: Pick<Readonly<Settings>, "stack" | "variables" | "version">,
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
        MATCHORY_DEPLOYMENT_STACK: stack,
        MATCHORY_DEPLOYMENT_VERSION: version,
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
  {
    stack,
    variables,
    version,
  }: Pick<Readonly<Settings>, "stack" | "variables" | "version">,
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
        MATCHORY_DEPLOYMENT_STACK: stack,
        MATCHORY_DEPLOYMENT_VERSION: version,
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
  core.startGroup("Listing services");

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
    const output = await executeDockerCommand([
      "service",
      "ls",
      "--format=json",
      ...filterFlags,
    ]);
    const services = parseLineDelimitedJson<ServiceMetadata>(output);

    if (!inspect) {
      return services;
    }

    return Promise.all(
      services.map((metadata) =>
        inspectService(metadata.ID).then((service) => ({
          ...metadata,
          ...service,
        })),
      ),
    );
  } catch (cause) {
    throw new Error(`Failed to list services: ${cause}`, { cause });
  } finally {
    core.endGroup();
  }
}

export async function inspectService(id: string) {
  const output = await executeDockerCommand([
    "service",
    "inspect",
    "--format=json",
    id,
  ]);

  try {
    return JSON.parse(output) as Service;
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
    const output = await executeDockerCommand([
      "service",
      "logs",
      "--raw",
      "--no-trunc",
      "--details",
      "--timestamps",
      tail ? `--tail=${tail}` : "",
      since ? `--since=${since.toISOString()}` : "",
      id,
    ]);

    return output
      .trim()
      .split("\n")
      .map((line = "") => {
        const [timestamp, metadata, ...rest] = line.split(" ");

        return {
          timestamp: new Date(timestamp),
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
  core.startGroup("Listing secrets");

  const filterFlags = buildFilters({
    id: filters.id,
    name: filters.name,
    label: filters.labels ? parseLabelFilter(filters.labels) : undefined,
  });

  try {
    const output = await executeDockerCommand([
      "secret",
      "ls",
      "--format=json",
      ...filterFlags,
    ]);

    return parseLineDelimitedJson<StoredVariable>(output).map<SecretMetadata>(
      (secret) => ({
        ...secret,
        Labels: parseLabels(secret.Labels ?? ""),
      }),
    );
  } catch (cause) {
    throw new Error(`Failed to list secrets: ${cause}`, { cause });
  } finally {
    core.endGroup();
  }
}

export async function listConfigs(filters: {
  id?: ValueFilter;
  name?: ValueFilter;
  labels?: KeyValueFilter;
}) {
  core.startGroup("Listing configs");

  const filterFlags = buildFilters({
    id: filters.id,
    name: filters.name,
    label: filters.labels ? parseLabelFilter(filters.labels) : undefined,
  });

  try {
    const output = await executeDockerCommand([
      "config",
      "ls",
      "--format=json",
      ...filterFlags,
    ]);

    return parseLineDelimitedJson<StoredVariable>(output).map<ConfigMetadata>(
      (config) => ({
        ...config,
        Labels: parseLabels(config.Labels ?? ""),
      }),
    );
  } catch (cause) {
    throw new Error(`Failed to list configs: ${cause}`, { cause });
  } finally {
    core.endGroup();
  }
}

export async function removeSecret(id: string) {
  core.startGroup(`Removing secret "${id}"`);

  try {
    await executeDockerCommand(["secret", "rm", id]);
  } catch (cause) {
    throw new Error(`Failed to remove secret "${id}": ${cause}`, { cause });
  } finally {
    core.endGroup();
  }
}

export async function removeConfig(id: string) {
  core.startGroup(`Removing config "${id}"`);
  try {
    await executeDockerCommand(["config", "rm", id]);
  } catch (cause) {
    throw new Error(`Failed to remove config "${id}": ${cause}`, { cause });
  } finally {
    core.endGroup();
  }
}

/**
 * Execute a Docker command
 *
 * This function executes a Docker command with the given arguments and options.
 * It captures the output from stdout and returns it as a string.
 *
 * @param args
 * @param stdin
 * @param env
 * @param silent
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
        },
      },
    );
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

function parseFilter<K extends string, V extends string>(
  key: K,
  values: ValueFilter<V>,
): NamedFilter<K, V>[] {
  const filter = Array.isArray(values) ? values : ([values] as const);

  return filter.map((value) => `${key}=${value}` as const);
}

function parseLabelFilter(
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
  Spec: {
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
  UpdateStatus: {
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
type NamedFilter<
  K extends string = string,
  V extends string = string,
> = `${K}=${V}`;
