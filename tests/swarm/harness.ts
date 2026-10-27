import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { expect, inject } from "vitest";

// Runs the bundled action against the swarm of the current Docker context, the
// way the runner does: `node dist/index.js` with inputs as `INPUT_*` variables.
// Build `dist/` first; the suite tests whatever bundle is there.

const root = resolve(import.meta.dirname, "../..");
const entry = join(root, "dist/index.js");
const prefix = process.env.SWARM_TEST_PREFIX || "e2e";
const run = promisify(execFile);

export const image = "busybox:1.37";

export interface ActionRun {
  exitCode: number;
  outputs: Record<string, string>;
  log: string;
  /** Messages of the `::error` annotations, in order */
  errors: string[];
  /** Messages of the `::warning` annotations, in order */
  warnings: string[];
}

/**
 * Reserve a stack name no earlier scenario used
 *
 * Removing a stack and deploying one of the same name right after can fail
 * with "network <stack>_default not found", so names are never reused. The
 * stack is removed after the last scenario file; see `global-setup.ts`.
 */
export function stackName(area: string) {
  const name = `${prefix}-${area}-${randomBytes(3).toString("hex")}`;
  appendFileSync(inject("stackList"), `${name}\n`);

  return name;
}

/**
 * Run the action in a fresh workspace holding the given files
 *
 * @param files File contents keyed by path relative to the workspace
 * @param inputs Action inputs, as written in a workflow
 */
export async function runAction(
  files: Record<string, string>,
  inputs: Record<string, string>,
): Promise<ActionRun> {
  // The real path, as the working directory of the action resolves to it
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "swarm-test-")),
  );

  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content);
    }

    const outputFile = join(workspace, ".github-output");
    await writeFile(outputFile, "");

    const env: NodeJS.ProcessEnv = {
      // Every environment variable is a deployment variable, so only what
      // Docker needs is passed through.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: join(workspace, ".github-step-summary"),
      GITHUB_REPOSITORY: "matchory/swarm-test",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REF: "refs/heads/main",
      GITHUB_ACTOR: "swarm-test",
    };
    await writeFile(env.GITHUB_STEP_SUMMARY as string, "");

    for (const [name, value] of Object.entries({
      ...(await inputDefaults()),
      "upload-compose-spec": "false",
      ...inputs,
    })) {
      env[`INPUT_${name.toUpperCase()}`] = value;
    }

    const { exitCode, log } = await new Promise<{
      exitCode: number;
      log: string;
    }>((done, fail) => {
      const child = spawn(process.execPath, [entry], { cwd: workspace, env });
      let log = "";
      child.stdout.on("data", (chunk) => {
        log += chunk;
      });
      child.stderr.on("data", (chunk) => {
        log += chunk;
      });
      child.on("error", fail);
      child.on("close", (code) => done({ exitCode: code ?? -1, log }));
    });

    return {
      exitCode,
      outputs: parseOutputs(await readFile(outputFile, "utf8")),
      log,
      errors: annotations(log, "error"),
      warnings: annotations(log, "warning"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

let defaults: Record<string, string> | undefined;

// The runner sets an `INPUT_*` variable for every input with a default
async function inputDefaults() {
  if (!defaults) {
    const action = load(await readFile(join(root, "action.yml"), "utf8")) as {
      inputs: Record<string, { default?: string }>;
    };
    defaults = Object.fromEntries(
      Object.entries(action.inputs)
        .filter(([, input]) => input.default !== undefined)
        .map(([name, input]) => [name, String(input.default)]),
    );
  }

  return defaults;
}

function parseOutputs(content: string) {
  const outputs: Record<string, string> = {};
  const pattern = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;

  for (const [, name, , value] of content.matchAll(pattern)) {
    outputs[name] = value;
  }

  return outputs;
}

function annotations(log: string, level: "error" | "warning") {
  return [...log.matchAll(new RegExp(`^::${level}[^:]*::(.*)$`, "gm"))].map(
    ([, message]) =>
      message
        .replaceAll("%0A", "\n")
        .replaceAll("%0D", "\r")
        .replaceAll("%25", "%"),
  );
}

/**
 * Run the Docker CLI and return its trimmed standard output
 */
export async function docker(...args: string[]) {
  const { stdout } = await run("docker", args, { maxBuffer: 64 * 1024 * 1024 });

  return stdout.trim();
}

/**
 * Deploy a stack with the Docker CLI alone, bypassing the action
 */
export async function deployRaw(stack: string, compose: string) {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-test-"));
  const file = join(workspace, "compose.yaml");

  try {
    await writeFile(file, compose);
    await run("docker", [
      "stack",
      "deploy",
      "--detach=false",
      "-c",
      file,
      stack,
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export interface ServiceInspect {
  ID: string;
  Spec: {
    Name: string;
    Labels?: Record<string, string>;
    TaskTemplate: {
      ContainerSpec: {
        Labels?: Record<string, string>;
        Configs?: Array<{ ConfigName: string }>;
        Secrets?: Array<{ SecretName: string }>;
      };
    };
    Mode: Record<string, unknown>;
  };
  PreviousSpec?: ServiceInspect["Spec"];
  UpdateStatus?: { State: string };
}

/**
 * Inspect every service of a stack, keyed by service name without the stack
 */
export async function services(stack: string) {
  const ids = await docker(
    "service",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.stack.namespace=${stack}`,
  );

  if (!ids) {
    return {};
  }

  const inspected = JSON.parse(
    await docker("service", "inspect", ...ids.split("\n")),
  ) as ServiceInspect[];

  return Object.fromEntries(
    inspected.map((service) => [
      service.Spec.Name.slice(stack.length + 1),
      service,
    ]),
  );
}

/**
 * The Replicas column of `docker service ls` for a stack's service
 */
export async function replicas(stack: string, service: string) {
  return docker(
    "service",
    "ls",
    "--filter",
    `name=${stack}_${service}`,
    "--format",
    "{{.Replicas}}",
  );
}

export interface Task {
  ID: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
}

/**
 * Every task of a stack's service, including finished ones, newest first
 */
export async function tasks(stack: string, service: string): Promise<Task[]> {
  const lines = await docker(
    "service",
    "ps",
    "--no-trunc",
    "--format",
    "{{json .}}",
    `${stack}_${service}`,
  );

  return lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
}

/**
 * Names of the configs or secrets labelled as belonging to a stack
 */
export async function variables(kind: "config" | "secret", stack: string) {
  const names = await docker(
    kind,
    "ls",
    "--filter",
    `label=com.docker.stack.namespace=${stack}`,
    "--format",
    "{{.Name}}",
  );

  return names ? names.split("\n").sort() : [];
}

/**
 * Run the action and expect it to succeed, showing its log otherwise
 */
export async function runSuccessfully(
  files: Record<string, string>,
  inputs: Record<string, string>,
) {
  const run = await runAction(files, inputs);
  expect(run.exitCode, run.log).toBe(0);

  return run;
}
