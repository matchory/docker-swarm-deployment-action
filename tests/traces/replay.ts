import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { vi } from "vitest";
import { monitorDeployment } from "../../src/monitoring.js";
import type { Settings } from "../../src/settings.js";
import { at, type Change, stackPlaceholder, type Trace } from "./trace.js";

// Replays traces through `@actions/exec`, so monitoring and the engine's
// parsing run unchanged against real Docker output. Tests using this module
// must mock "@actions/core" and "@actions/exec", and use fake timers.

export const stack = "replay";

/**
 * A trace as it appears in a replay: shifted, stretched, thinned out, and
 * with its services renamed so traces can be combined into one stack
 */
export interface Source {
  trace: Trace;
  /** Milliseconds after the deploy at which the trace starts */
  offset?: number;
  /** Factor stretching the trace's time */
  scale?: number;
  /** Indices of the recorded polls to skip, by the time they happened */
  skip?: ReadonlySet<number>;
  /** Names for the trace's services in the replay, by recorded name */
  names?: Readonly<Record<string, string>>;
}

export interface Outcome {
  ok: boolean;
  error?: string;
  /** Milliseconds monitoring took */
  elapsed: number;
  /** The `core.error` annotations it emitted */
  errors: string[];
}

/**
 * Run monitoring against the sources, on a fake clock starting at the deploy
 */
export async function replay(
  sources: Source[],
  settings: Pick<Settings, "monitorInterval" | "monitorTimeout">,
  options: Map<
    string,
    { monitor: boolean; monitorTimeout: number }
  > = new Map(),
): Promise<Outcome> {
  const views = sources.map(view);
  vi.setSystemTime(0);
  vi.mocked(core.error).mockClear();
  vi.mocked(exec).mockImplementation(
    async (_command, args = [], execOptions) => {
      const change = respond(views, args, Date.now());

      if (change.stdout) {
        execOptions?.listeners?.stdout?.(Buffer.from(change.stdout));
      }

      if (change.exitCode !== 0) {
        throw new Error(
          `The process 'docker' failed with exit code ${change.exitCode}`,
        );
      }

      return 0;
    },
  );

  let result: { ok: boolean; error?: string } | undefined;

  monitorDeployment(
    {
      ...settings,
      monitor: true,
      stack,
    } as Settings,
    undefined,
    options,
  ).then(
    () => {
      result = { ok: true };
    },
    (error: Error) => {
      result = { ok: false, error: error.message };
    },
  );

  // Docker answers instantly here, so only the polls take time
  while (!result) {
    await vi.advanceTimersByTimeAsync(100);

    if (Date.now() > 3_600_000) {
      throw new Error("Monitoring did not finish within an hour");
    }
  }

  return {
    ...result,
    elapsed: Date.now(),
    errors: vi
      .mocked(core.error)
      .mock.calls.map(([message]) => String(message)),
  };
}

interface View {
  /** Output current at a replay time, by command */
  ls(time: number): Change | undefined;
  inspect(time: number): Change | undefined;
  ps(name: string, time: number): Change | undefined;
  logs(name: string, time: number): Change | undefined;
  /** Replay names of the services, by ID */
  ids: Map<string, string>;
}

function view({
  trace,
  offset = 0,
  scale = 1,
  skip = new Set(),
  names = {},
}: Source): View {
  const rename = (stdout: string) => {
    let result = stdout;

    for (const [from, to] of Object.entries(names)) {
      result = result.replaceAll(
        `${stackPlaceholder}_${from}`,
        `${stackPlaceholder}_${to}`,
      );
    }

    return result.replaceAll(stackPlaceholder, stack);
  };
  const keep = (changes: Change[] | undefined) =>
    (changes ?? [])
      .filter((change, index) => index === 0 || !skip.has(change.at))
      .map((change, index) => ({
        ...change,
        // The first poll is a moment after the deploy, but stands for it
        at: offset + (index === 0 ? 0 : change.at) * scale,
        stdout: rename(change.stdout),
      }));
  const ls = keep(trace.ls);
  const inspect = keep(trace.inspect);
  const ps = new Map(
    Object.entries(trace.ps).map(([name, changes]) => [
      names[name] ?? name,
      keep(changes),
    ]),
  );
  const logs = new Map(
    Object.entries(trace.logs).map(([name, changes]) => [
      names[name] ?? name,
      keep(changes),
    ]),
  );
  const ids = new Map<string, string>();

  for (const { stdout } of ls) {
    for (const line of stdout.split("\n").filter(Boolean)) {
      const { ID, Name } = JSON.parse(line) as { ID: string; Name: string };
      ids.set(ID, Name.slice(stack.length + 1));
    }
  }

  return {
    ls: (time) => at(ls, time),
    inspect: (time) => at(inspect, time),
    ps: (name, time) => at(ps.get(name), time),
    logs: (name, time) => at(logs.get(name), time),
    ids,
  };
}

function respond(views: View[], args: string[], time: number): Change {
  const [, command] = args;
  const id = args.at(-1) ?? "";
  const owner = (prefix: string) =>
    views
      .map((view) => {
        // `service ls` reports short IDs, `service inspect` full ones
        const match = [...view.ids].find(
          ([short]) => prefix.startsWith(short) || short.startsWith(prefix),
        );

        return match ? { view, name: match[1] } : undefined;
      })
      .find(Boolean);

  switch (command) {
    case "ls": {
      const outputs = views.map((view) => view.ls(time));

      return {
        at: time,
        exitCode: 0,
        stdout: outputs
          .map((output) => output?.stdout ?? "")
          .filter(Boolean)
          .join(""),
      };
    }
    case "inspect": {
      const requested = args.filter((arg) => !arg.startsWith("-")).slice(2);
      const services = views.flatMap(
        (view) =>
          JSON.parse(view.inspect(time)?.stdout || "[]") as Array<{
            ID: string;
          }>,
      );

      return {
        at: time,
        exitCode: 0,
        stdout: JSON.stringify(
          services.filter(({ ID }) =>
            requested.some((prefix) => ID.startsWith(prefix)),
          ),
        ),
      };
    }
    case "ps":
    case "logs": {
      const found = owner(id);
      const change = found?.view[command](found.name, time);

      return change ?? { at: time, exitCode: 1, stdout: "" };
    }
    default:
      throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  }
}
