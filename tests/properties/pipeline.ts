import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as core from "@actions/core";
import { dump, load } from "js-yaml";
import { vi } from "vitest";
import {
  type ComposeSpec,
  composeSchema,
  interpolateSpec,
  interpolateTypedFields,
  loadComposeSpecs,
  normalizeSpec,
} from "../../src/compose.js";
import { serializeForDeploy } from "../../src/engine.js";
import {
  addDeploymentLabels,
  resolveServiceOptions,
} from "../../src/labels.js";
import type { Settings } from "../../src/settings.js";
import { removeGeneratedVariableFiles } from "../../src/variables.js";

// Drives the action's Compose pipeline in-process, as `deploy()` does up to
// `docker stack deploy`, and asks the Docker CLI for its own reading of the
// same files. Tests using this module must mock "@actions/core".

const run = promisify(execFile);

/**
 * Whether the Docker CLI with the Compose plugin is available
 */
export async function dockerAvailable() {
  try {
    await run("docker", ["compose", "version"]);
    await run("docker", ["stack", "config", "--help"]);

    return true;
  } catch {
    return false;
  }
}

/**
 * Budget of a property: a fixed seed and few runs on pull requests, more and
 * random ones nightly (`PROPERTY_RUNS`, and `PROPERTY_SEED=random`)
 */
export const budget = {
  numRuns: Number(process.env.PROPERTY_RUNS || 25),
  seed:
    process.env.PROPERTY_SEED === "random"
      ? undefined
      : Number(process.env.PROPERTY_SEED || 240),
};

export const deploymentLabels = {
  "com.matchory.deployment.version": "v1",
  "com.matchory.deployment.commit": "0123456",
};

export interface Inputs {
  /** Compose files in merge order, as parsed objects; dumped with tags */
  files: ComposeSpec[];
  profiles?: string[];
  keyInterpolation?: boolean;
  variables?: Record<string, string>;
}

export type Outcome<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

interface Pipeline {
  /** Merged spec, before interpolation, as `normalizeSpec` returns it */
  normalized: ComposeSpec;
  /** Spec the action would pass to `docker stack deploy` */
  final: ComposeSpec;
}

/**
 * Run the action's pipeline on the inputs in a fresh workspace
 */
export async function runPipeline(inputs: Inputs): Promise<Outcome<Pipeline>> {
  return inWorkspace(inputs, async (paths) => {
    const settings = settingsFor(inputs);
    const loaded = (await loadComposeSpecs(paths, settings)).map((item) => ({
      ...item,
      spec: interpolateTypedFields(item.spec, settings),
    }));

    try {
      const normalized = await normalizeSpec(loaded, settings);
      let final = interpolateSpec(structuredClone(normalized), settings);
      resolveServiceOptions(final, settings);
      final = addDeploymentLabels(final, deploymentLabels);

      return { normalized, final };
    } finally {
      await removeGeneratedVariableFiles();
    }
  });
}

/**
 * The merged and interpolated spec `docker compose config` produces
 *
 * Without profiles the action deploys every service, which is what Compose
 * does with every profile active. Not `config --services`: it skips the env
 * files, which the full command reads like the action does.
 */
export async function composeConfig(
  inputs: Inputs,
): Promise<Outcome<ComposeSpec>> {
  return inWorkspace(inputs, async (paths) => {
    const { stdout } = await compose(inputs, paths, [
      "config",
      "--format",
      "json",
    ]);

    return JSON.parse(stdout) as ComposeSpec;
  });
}

/**
 * Read a final spec with `docker stack config`, serialized and interpolated
 * as `docker stack deploy` receives it
 */
export async function stackConfig(
  spec: ComposeSpec,
  variables: Record<string, string> = {},
): Promise<Outcome<ComposeSpec>> {
  return inWorkspace({ files: [] }, async (_, directory) => {
    const file = join(directory, "final.yaml");
    await writeFile(file, serializeForDeploy(spec));
    const { stdout } = await run(
      "docker",
      ["stack", "config", "--compose-file", file],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...variables },
      },
    );

    return load(stdout) as ComposeSpec;
  });
}

function compose(inputs: Inputs, paths: string[], args: string[]) {
  const profiles = inputs.profiles ?? ["*"];

  return run(
    "docker",
    [
      "compose",
      ...paths.flatMap((path) => ["--file", path]),
      ...profiles.flatMap((profile) => ["--profile", profile]),
      ...args,
    ],
    {
      cwd: paths.length > 0 ? join(paths[0], "..") : undefined,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...inputs.variables,
      },
    },
  );
}

function settingsFor(inputs: Inputs): Settings {
  return {
    envVarPrefix: "DEPLOYMENT",
    healthCheckWarnings: false,
    keyInterpolation: inputs.keyInterpolation ?? false,
    manageVariables: true,
    monitor: false,
    monitorInterval: 5,
    monitorTimeout: 300,
    profiles: inputs.profiles,
    secretValues: new Map(),
    stack: "property",
    strictCompatibility: false,
    strictVariables: true,
    uploadComposeSpec: false,
    variables: new Map(Object.entries(inputs.variables ?? {})),
    version: "v1",
  };
}

// Write the files to a fresh directory, run `fn` with it as the working
// directory and workspace, as the action runs, and capture the outcome
async function inWorkspace<T>(
  { files }: Pick<Inputs, "files">,
  fn: (paths: string[], directory: string) => Promise<T>,
): Promise<Outcome<T>> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "compose-property-")),
  );
  const cwd = process.cwd();
  const workspace = process.env.GITHUB_WORKSPACE;
  const paths = files.map((_, index) =>
    join(directory, `compose.${index}.yaml`),
  );
  vi.mocked(core.warning).mockClear();

  try {
    for (const [index, spec] of files.entries()) {
      await writeFile(paths[index], dump(spec, { schema: composeSchema }));
    }

    // The env files generated services may use, all but "missing.env"
    await writeFile(join(directory, "present.env"), "E1=present\nP=present\n");
    await writeFile(join(directory, "other.env"), "E2=other\nO=other\n");

    process.chdir(directory);
    process.env.GITHUB_WORKSPACE = directory;

    const value = await fn(paths, directory);

    return { ok: true, value, warnings: warnings() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr ?? "";

    return { ok: false, error: `${message}\n${stderr}`, warnings: warnings() };
  } finally {
    process.chdir(cwd);

    if (workspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = workspace;
    }

    await rm(directory, { recursive: true, force: true });
  }
}

function warnings() {
  return vi.mocked(core.warning).mock.calls.map(([message]) => String(message));
}
