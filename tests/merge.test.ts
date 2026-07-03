import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadComposeSpecs } from "../src/compose.js";
import { defineSettings } from "../src/settings.js";

// NOTE: js-yaml is intentionally NOT mocked in this file so we exercise the
// real YAML parser and verify merge-key (`<<:`) resolution end to end.

const readFile = vi.hoisted(() => vi.fn());

vi.mock("@actions/core");
vi.mock("node:fs/promises", () => ({ readFile }));

const settings = defineSettings({
  envVarPrefix: "DEPLOYMENT",
  keyInterpolation: false,
  manageVariables: false,
  monitor: false,
  monitorInterval: 5,
  monitorTimeout: 300,
  stack: "test-stack",
  strictVariables: false,
  variables: new Map(),
  version: "ebadf1",
});

describe("YAML merge keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resolves `<<:` merge keys by spreading the anchored mapping", async () => {
    readFile.mockResolvedValue(`
x-defaults: &defaults
  restart: unless-stopped
  networks:
    - web
services:
  api:
    <<: *defaults
    image: api:latest
  worker:
    <<: *defaults
    image: worker:latest
`);

    const [{ spec }] = await loadComposeSpecs(["compose.yaml"], settings);

    expect(spec.services.api).toEqual({
      restart: "unless-stopped",
      networks: ["web"],
      image: "api:latest",
    });
    expect(spec.services.worker).toEqual({
      restart: "unless-stopped",
      networks: ["web"],
      image: "worker:latest",
    });
    // The literal merge key must never survive into the resolved spec.
    expect(spec.services.api).not.toHaveProperty("<<");
  });
});
