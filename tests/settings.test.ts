import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../src/settings.js";

vi.mock("@actions/core");

describe("settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("should parse settings with default values", () => {
    const settings = parseSettings();

    expect(settings.stack).toBe("unknown");
    expect(settings.version).toBe("unknown");
    expect(settings.composeFiles).toEqual([]);
    expect(settings.envVarPrefix).toBe("DEPLOYMENT");
    expect(settings.monitor).toBe(false);
    expect(settings.monitorTimeout).toBe(300);
    expect(settings.monitorInterval).toBe(5);
  });

  it("should parse settings with provided inputs", () => {
    vi.spyOn(core, "getInput").mockImplementation(
      (name) =>
        ({
          "stack-name": "custom-stack",
          version: "1.0.0",
          "compose-file": "file1.yml:file2.yml",
          "env-var-prefix": "CUSTOM_PREFIX",
          "monitor-timeout": "600",
          "monitor-interval": "10",
        })[name] || "",
    );
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);

    const settings = parseSettings();

    expect(settings.stack).toBe("custom-stack");
    expect(settings.version).toBe("1.0.0");
    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
    expect(settings.envVarPrefix).toBe("CUSTOM_PREFIX");
    expect(settings.monitor).toBe(true);
    expect(settings.monitorTimeout).toBe(600);
    expect(settings.monitorInterval).toBe(10);
  });

  it("should infer version from GITHUB_REF", () => {
    vi.stubEnv("GITHUB_REF", "refs/tags/v1.2.3");

    const settings = parseSettings();

    expect(settings.version).toBe("v1.2.3");
  });

  it("should infer version from GITHUB_SHA if no GITHUB_REF is specified", () => {
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");

    const settings = parseSettings();

    expect(settings.version).toBe("4fadb58");
  });

  it("should infer stack name from GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "user/repo");

    const settings = parseSettings();

    expect(settings.stack).toBe("repo");
  });

  it("should handle missing GITHUB_REPOSITORY gracefully", () => {
    const settings = parseSettings();

    expect(settings.stack).toBe("unknown");
  });

  it("should retrieve compose files from COMPOSE_FILE environment variable", () => {
    vi.stubEnv("COMPOSE_FILE", "file1.yml,file2.yml");
    vi.stubEnv("COMPOSE_PATH_SEPARATOR", ",");

    const settings = parseSettings();

    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
  });
});
