import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A trace is the Docker output monitoring reads, as a real swarm produced it
// over time after `docker stack deploy`. It is recorded by record.trace.ts and
// replayed by replay.ts. The stack name is stored as `stackPlaceholder`, so
// traces can be replayed under any stack name, and combined into one stack.

export const stackPlaceholder = "__STACK__";

export const fixtures = resolve(import.meta.dirname, "fixtures");

/**
 * The output of a command from the time it was first seen until the next
 */
export interface Change {
  /** Milliseconds since the deploy returned */
  at: number;
  exitCode: number;
  stdout: string;
}

export interface Trace {
  scenario: string;
  /** Server version of the Docker Engine that produced the trace */
  docker: string;
  /** Milliseconds between polls */
  interval: number;
  /** Milliseconds recorded after the deploy returned */
  duration: number;
  /** `docker service ls --format=json` for the stack */
  ls: Change[];
  /** `docker service inspect --format=json` of every service of the stack */
  inspect: Change[];
  /** `docker service ps --format=json --no-trunc`, by service name */
  ps: Record<string, Change[]>;
  /** `docker service logs --raw --no-trunc --timestamps`, by service name */
  logs: Record<string, Change[]>;
}

/**
 * The output current at a point in time, or undefined before the first
 */
export function at(changes: Change[] | undefined, time: number) {
  let current: Change | undefined;

  for (const change of changes ?? []) {
    if (change.at > time) {
      break;
    }

    current = change;
  }

  return current;
}

/**
 * Every recorded trace, by scenario name
 */
export function loadTraces(): Map<string, Trace> {
  const traces = new Map<string, Trace>();

  for (const file of readdirSync(fixtures).filter((name) =>
    name.endsWith(".json"),
  )) {
    const trace = JSON.parse(
      readFileSync(join(fixtures, file), "utf8"),
    ) as Trace;
    traces.set(trace.scenario, trace);
  }

  return traces;
}
