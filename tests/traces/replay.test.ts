import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay, stack } from "./replay.js";
import { scenarios } from "./scenarios.js";
import { loadTraces, type Trace } from "./trace.js";

vi.mock("@actions/core");
vi.mock("@actions/exec");

const traces = loadTraces();

beforeEach(() => {
  vi.useFakeTimers();
});

describe("monitoring a recorded trace", () => {
  it.each(scenarios.filter(({ name }) => traces.has(name)))(
    "$name",
    async ({ name, replay: settings, expected }) => {
      const trace = traces.get(name) as Trace;
      const outcome = await replay([{ trace }], settings);

      if (expected.outcome === "success") {
        expect(outcome.ok, outcome.errors.join("\n")).toBe(true);

        return;
      }

      expect(outcome.ok).toBe(false);
      expect(outcome.errors).toContainEqual(
        expect.stringMatching(
          new RegExp(`^Service "${stack}_\\w+" failed to deploy: `),
        ),
      );
      expect(outcome.errors.join("\n")).toMatch(expected.headline);

      if (expected.error) {
        expect(outcome.error).toMatch(expected.error);
      }
    },
  );

  it("has a trace of every scenario", () => {
    expect([...traces.keys()].sort()).toEqual(
      scenarios.map(({ name }) => name).sort(),
    );
  });
});
