import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { it } from "vitest";
import { docker, stackName } from "../swarm/harness.js";
import { type Context, scenarios } from "./scenarios.js";
import {
  type Change,
  fixtures,
  stackPlaceholder,
  type Trace,
} from "./trace.js";

// Records a trace of every scenario on the swarm of the current Docker
// context: run `npm run traces:record`, optionally with SCENARIOS=name,name.

const run = promisify(execFile);
const interval = 1_000;
const only = process.env.SCENARIOS?.split(",").filter(Boolean);

for (const scenario of scenarios) {
  const record = !only || only.includes(scenario.name) ? it : it.skip;

  record(scenario.name, { timeout: scenario.duration + 180_000 }, async () => {
    const context = createContext(stackName("trace"));
    await scenario.prepare?.(context);
    await context.deploy(scenario.compose);

    const trace = await poll(context, scenario.duration, scenario.during);
    const name = `${scenario.name}.json`;
    const content = JSON.stringify(
      { scenario: scenario.name, ...trace },
      null,
      2,
    ).replaceAll(context.stack, stackPlaceholder);

    await writeFile(join(fixtures, name), `${content}\n`);
  });
}

function createContext(stack: string): Context {
  return {
    stack,
    otherStack: () => stackName("trace"),
    async deploy(compose, { wait = false, stack: target = stack } = {}) {
      const directory = await mkdtemp(join(tmpdir(), "trace-"));
      const file = join(directory, "compose.yaml");

      try {
        await writeFile(file, compose);
        // As the action deploys, so the first poll sees what monitoring would
        await run("docker", [
          "stack",
          "deploy",
          "--prune",
          "--quiet",
          `--detach=${!wait}`,
          "--resolve-image=always",
          "--compose-file",
          file,
          target,
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async remove(target) {
      await run("docker", ["stack", "rm", "--detach=false", target]);
    },
  };
}

async function poll(
  context: Context,
  duration: number,
  during:
    | { after: number; run: (context: Context) => Promise<void> }
    | undefined,
): Promise<Omit<Trace, "scenario">> {
  const trace: Omit<Trace, "scenario"> = {
    docker: await docker("version", "--format", "{{.Server.Version}}"),
    interval,
    duration,
    ls: [],
    inspect: [],
    ps: {},
    logs: {},
  };
  const start = Date.now();
  let action: Promise<void> | undefined;

  for (let next = 0; next <= duration; next += interval) {
    await setTimeout(Math.max(0, start + next - Date.now()));
    const now = Date.now() - start;

    if (during && !action && now >= during.after) {
      action = during.run(context);
    }

    const ls = await capture(now, [
      "service",
      "ls",
      "--format=json",
      "--filter",
      `label=com.docker.stack.namespace=${context.stack}`,
    ]);
    append(trace.ls, ls);

    const services = ls.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { ID: string; Name: string });

    if (services.length === 0) {
      continue;
    }

    const [inspect, ...perService] = await Promise.all([
      capture(now, [
        "service",
        "inspect",
        "--format=json",
        ...services.map(({ ID }) => ID),
      ]),
      ...services.flatMap(({ ID }) => [
        capture(now, ["service", "ps", "--format=json", "--no-trunc", ID]),
        capture(now, [
          "service",
          "logs",
          "--raw",
          "--no-trunc",
          "--timestamps",
          "--tail=50",
          ID,
        ]),
      ]),
    ]);
    append(trace.inspect, inspect);

    for (const [index, { Name }] of services.entries()) {
      const name = Name.slice(context.stack.length + 1);
      trace.ps[name] ??= [];
      trace.logs[name] ??= [];
      append(trace.ps[name], perService[index * 2]);
      append(trace.logs[name], perService[index * 2 + 1]);
    }
  }

  await action;

  return trace;
}

async function capture(at: number, args: string[]): Promise<Change> {
  try {
    const { stdout } = await run("docker", args, {
      maxBuffer: 64 * 1024 * 1024,
    });

    return { at, exitCode: 0, stdout };
  } catch (error) {
    const { code, stdout = "" } = error as { code?: number; stdout?: string };

    return { at, exitCode: typeof code === "number" ? code : 1, stdout };
  }
}

// Keep only changes: most polls see the same output as the one before
function append(changes: Change[], change: Change) {
  const last = changes.at(-1);

  if (
    !last ||
    last.stdout !== change.stdout ||
    last.exitCode !== change.exitCode
  ) {
    changes.push(change);
  }
}
