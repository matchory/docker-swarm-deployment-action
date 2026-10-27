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
import { expect, inject, onTestFinished } from "vitest";

// Runs the bundled action against the swarm of the current Docker context, the
// way the runner does: `node dist/index.js` with inputs as `INPUT_*` variables.
// Build `dist/` first; the suite tests whatever bundle is there.

const root = resolve(import.meta.dirname, "../..");
const entry = join(root, "dist/index.js");
const prefix = process.env.SWARM_TEST_PREFIX || "e2e";
const run = promisify(execFile);

export const image = "busybox:1.37";

// The runner sets an `INPUT_*` variable for every input with a default
const action = load(await readFile(join(root, "action.yml"), "utf8")) as {
  inputs: Record<string, { default?: string }>;
};
const defaults = Object.fromEntries(
  Object.entries(action.inputs)
    .filter(([, input]) => input.default !== undefined)
    .map(([name, input]) => [name, String(input.default)]),
);

interface ActionRun {
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
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
      DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY,
      DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH,
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
      ...defaults,
      "upload-compose-spec": "false",
      ...inputs,
    })) {
      env[`INPUT_${name.toUpperCase()}`] = value;
    }

    const { exitCode, log, stdout } = await new Promise<{
      exitCode: number;
      log: string;
      stdout: string;
    }>((done, fail) => {
      const child = spawn(process.execPath, [entry], { cwd: workspace, env });
      // A timed-out test must not leave the action deploying behind it
      onTestFinished(() => {
        child.kill();
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let log = "";
      // Annotations are read from stdout alone: a stderr chunk can land in
      // the middle of a stdout line in the combined log
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        log += chunk;
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        log += chunk;
      });
      child.on("error", fail);
      child.on("close", (code) => done({ exitCode: code ?? -1, log, stdout }));
    });

    return {
      exitCode,
      outputs: parseOutputs(await readFile(outputFile, "utf8")),
      log,
      errors: annotations(stdout, "error"),
      warnings: annotations(stdout, "warning"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

interface ServiceInspect {
  ID: string;
  Spec: {
    Name: string;
    Labels?: Record<string, string>;
    TaskTemplate: {
      ContainerSpec: {
        Labels?: Record<string, string>;
        Configs?: Array<{ ConfigName: string }>;
      };
    };
  };
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

interface Task {
  ID: string;
  DesiredState: string;
  CurrentState: string;
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
 * Inputs that monitor the deployment, polling every second
 */
export function monitored(stack: string, timeout = 60) {
  return {
    "stack-name": stack,
    monitor: "true",
    "monitor-interval": "1",
    "monitor-timeout": String(timeout),
  };
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
