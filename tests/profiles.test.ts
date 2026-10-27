import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import { Tagged } from "../src/override-tags.js";
import { selectProfiles } from "../src/profiles.js";

vi.mock("@actions/core");

describe("selectProfiles", () => {
  const files = (...specs: ComposeSpec["services"][]) =>
    specs.map((services) => ({ spec: { services } as ComposeSpec }));
  const services = (specs: Array<{ spec: ComposeSpec }>) =>
    specs.map(({ spec }) => spec.services);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should keep services without profiles and those of active ones", () => {
    const specs = files({
      web: { image: "nginx" },
      debug: { image: "busybox", profiles: ["debug"] },
      seed: { image: "busybox", profiles: ["seed", "staging"] },
    });

    selectProfiles(specs, ["staging"]);

    expect(services(specs)).toEqual([
      { web: { image: "nginx" }, seed: { image: "busybox" } },
    ]);
    expect(core.info).toHaveBeenCalledWith(
      'Skipping service "debug": none of its profiles (debug) is active',
    );
  });

  it("should keep only services without profiles when none is active", () => {
    const specs = files({
      web: { image: "nginx" },
      debug: { image: "busybox", profiles: ["debug"] },
    });

    selectProfiles(specs, []);

    expect(services(specs)).toEqual([{ web: { image: "nginx" } }]);
  });

  it("should activate every profile with *", () => {
    const specs = files({
      web: { image: "nginx" },
      debug: { image: "busybox", profiles: ["debug"] },
    });

    selectProfiles(specs, ["*"]);

    expect(services(specs)).toEqual([
      { web: { image: "nginx" }, debug: { image: "busybox" } },
    ]);
  });

  it("should combine a service's profiles across files", () => {
    const specs = files(
      { seed: { image: "busybox", profiles: ["seed"] } },
      { seed: { profiles: ["prod"] } },
    );

    selectProfiles(specs, ["prod"]);

    expect(services(specs)).toEqual([
      { seed: { image: "busybox" } },
      { seed: {} },
    ]);
  });

  it("should drop an inactive service from every file", () => {
    const specs = files(
      {
        web: { image: "nginx" },
        db: { image: "postgres", profiles: ["local"] },
      },
      { db: { image: "postgres:16" } },
    );

    selectProfiles(specs, ["prod"]);

    expect(services(specs)).toEqual([{ web: { image: "nginx" } }, {}]);
  });

  it("should honour !reset on profiles", () => {
    const specs = files(
      { tools: { image: "busybox", profiles: ["debug"] } },
      { tools: { profiles: new Tagged("!reset", "sequence", []) } },
    );

    selectProfiles(specs, ["prod"]);

    expect(services(specs)).toEqual([
      { tools: { image: "busybox" } },
      { tools: {} },
    ]);
  });

  it("should honour !override on profiles", () => {
    const specs = files(
      { tools: { image: "busybox", profiles: ["prod"] } },
      { tools: { profiles: new Tagged("!override", "sequence", ["debug"]) } },
    );

    selectProfiles(specs, ["prod"]);

    expect(services(specs)).toEqual([{}, {}]);
  });

  it.each([
    ["a list", ["db"]],
    ["a mapping", { db: { condition: "service_started" } }],
  ])("should reject depending on an inactive service in %s", (_, dependsOn) => {
    const specs = files({
      web: { image: "nginx", depends_on: dependsOn },
      db: { image: "postgres", profiles: ["local"] },
    });

    expect(() => selectProfiles(specs, ["prod"])).toThrow(
      'Service "web" depends on service "db", which is not deployed because ' +
        "none of its profiles (local) is active.",
    );
  });

  it("should allow depending on an active profiled service", () => {
    const specs = files({
      web: { image: "nginx", depends_on: ["db"] },
      db: { image: "postgres", profiles: ["local"] },
    });

    selectProfiles(specs, ["local"]);

    expect(services(specs)).toEqual([
      {
        web: { image: "nginx", depends_on: ["db"] },
        db: { image: "postgres" },
      },
    ]);
  });
});
