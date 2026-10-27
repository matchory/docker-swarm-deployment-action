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
  const select = (
    specs: Array<{ spec: ComposeSpec | undefined }>,
    active: string[],
    variables = new Map<string, string>(),
  ) => selectProfiles(specs, active, variables);
  const override = (entries: Record<string, unknown>) =>
    new Tagged("!override", "mapping", new Map(Object.entries(entries)));

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should keep services without profiles and those of active ones", () => {
    const specs = files({
      web: { image: "nginx" },
      debug: { image: "busybox", profiles: ["debug"] },
      seed: { image: "busybox", profiles: ["seed", "staging"] },
    });

    select(specs, ["staging"]);

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

    select(specs, []);

    expect(services(specs)).toEqual([{ web: { image: "nginx" } }]);
  });

  it("should activate every profile with *", () => {
    const specs = files({
      web: { image: "nginx" },
      debug: { image: "busybox", profiles: ["debug"] },
    });

    select(specs, ["*"]);

    expect(services(specs)).toEqual([
      { web: { image: "nginx" }, debug: { image: "busybox" } },
    ]);
  });

  it("should combine a service's profiles across files", () => {
    const specs = files(
      { seed: { image: "busybox", profiles: ["seed"] } },
      { seed: { profiles: ["prod"] } },
    );

    select(specs, ["prod"]);

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

    select(specs, ["prod"]);

    expect(services(specs)).toEqual([{ web: { image: "nginx" } }, {}]);
  });

  it("should skip files without services", () => {
    const specs = [
      { spec: undefined },
      { spec: { configs: {} } as unknown as ComposeSpec },
      ...files({ web: { image: "nginx" } }),
    ];

    select(specs, ["prod"]);

    expect(specs[2].spec?.services).toEqual({ web: { image: "nginx" } });
  });

  it("should interpolate profile names", () => {
    const specs = files({
      web: { image: "nginx", profiles: ["${DEPLOY_ENV}"] },
    });

    select(specs, ["staging"], new Map([["DEPLOY_ENV", "staging"]]));

    expect(services(specs)).toEqual([{ web: { image: "nginx" } }]);
  });

  describe("merge tags", () => {
    it("should honour !reset on profiles", () => {
      const specs = files(
        { tools: { image: "busybox", profiles: ["debug"] } },
        { tools: { profiles: new Tagged("!reset", "sequence", []) } },
      );

      select(specs, ["prod"]);

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

      select(specs, ["prod"]);

      expect(services(specs)).toEqual([{}, {}]);
    });

    it("should read the profiles of a service tagged as a whole", () => {
      const tagged = override({ image: "alpine", profiles: ["prod"] });
      const specs = files({ web: { image: "nginx" } }, { web: tagged });

      select(specs, ["staging"]);

      expect(services(specs)).toEqual([{}, {}]);
    });

    it("should drop earlier profiles for a service tagged as a whole", () => {
      const tagged = override({ image: "alpine", profiles: ["staging"] });
      const specs = files(
        { web: { image: "nginx", profiles: ["prod"] } },
        { web: tagged },
      );

      select(specs, ["staging"]);

      expect(services(specs)[1].web).toBe(tagged);
      expect((tagged.value as Map<string, unknown>).has("profiles")).toBe(
        false,
      );
    });
  });

  describe("extends", () => {
    it("should inherit the profiles of the extended service", () => {
      const specs = files({
        base: { image: "busybox", profiles: ["template"] },
        web: { extends: "base" },
        api: { extends: { service: "base" }, profiles: ["prod"] },
      });

      expect(() => select(specs, ["template"])).not.toThrow();
      expect(Object.keys(specs[0].spec.services)).toEqual([
        "base",
        "web",
        "api",
      ]);
    });

    it("should skip a service whose inherited profiles are inactive", () => {
      const specs = files({
        base: { image: "busybox", profiles: ["template"] },
        web: { extends: "base" },
        worker: { image: "busybox" },
      });

      select(specs, ["prod"]);

      expect(services(specs)).toEqual([{ worker: { image: "busybox" } }]);
    });

    it("should reject extending a skipped service", () => {
      const specs = files({
        base: { image: "busybox", profiles: ["template"] },
        api: { extends: "base", profiles: ["prod"] },
      });

      expect(() => select(specs, ["prod"])).toThrow(
        'Service "api" extends service "base", which is not deployed because ' +
          "none of its profiles (template) is active.",
      );
    });

    it("should leave bases in other files to Docker", () => {
      const specs = files({
        api: {
          extends: { file: "common.yaml", service: "base" },
          profiles: ["prod"],
        },
      });

      select(specs, ["prod"]);

      expect(Object.keys(specs[0].spec.services)).toEqual(["api"]);
    });
  });

  describe("dependencies", () => {
    it.each([
      ["a list", ["db", "cache"], ["cache"]],
      [
        "a mapping",
        { db: { condition: "service_started" }, cache: {} },
        { cache: {} },
      ],
    ])(
      "should remove dependencies on skipped services from %s",
      (_, dependsOn, expected) => {
        const specs = files({
          web: { image: "nginx", depends_on: dependsOn },
          db: { image: "postgres", profiles: ["local"] },
          cache: { image: "redis" },
        });

        select(specs, ["prod"]);

        expect(specs[0].spec.services.web).toEqual({
          image: "nginx",
          depends_on: expected,
        });
        expect(core.warning).toHaveBeenCalledWith(
          'Service "web" depends on service "db", which is not deployed ' +
            "because none of its profiles (local) is active; removed the " +
            "dependency.",
        );
      },
    );

    it("should remove dependencies from tagged lists", () => {
      const dependsOn = new Tagged("!override", "sequence", ["db"]);
      const specs = files(
        {
          web: { image: "nginx" },
          db: { image: "postgres", profiles: ["local"] },
        },
        { web: { depends_on: dependsOn } },
      );

      select(specs, ["prod"]);

      expect(dependsOn.value).toEqual([]);
    });

    it("should keep dependencies on active profiled services", () => {
      const specs = files({
        web: { image: "nginx", depends_on: ["db"] },
        db: { image: "postgres", profiles: ["local"] },
      });

      select(specs, ["local"]);

      expect(services(specs)).toEqual([
        {
          web: { image: "nginx", depends_on: ["db"] },
          db: { image: "postgres" },
        },
      ]);
      expect(core.warning).not.toHaveBeenCalled();
    });
  });
});
