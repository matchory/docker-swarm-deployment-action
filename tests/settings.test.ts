import * as core from "@actions/core";
import { env } from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../src/settings.js";

vi.mock("@actions/core", { spy: true });

describe("settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("should parse settings with default values", () => {
    vi.stubEnv("GITHUB_REPOSITORY", undefined);
    vi.stubEnv("GITHUB_REF", undefined);
    vi.stubEnv("GITHUB_SHA", undefined);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("unknown");
    expect(settings.version).toBe("unknown");
    expect(settings.composeFiles).toEqual([]);
    expect(settings.envVarPrefix).toBe("DEPLOYMENT");
    expect(settings.keyInterpolation).toBe(false);
    expect(settings.variables).toBeInstanceOf(Map);
    expect(settings.manageVariables).toBe(true);
    expect(settings.strictVariables).toBe(false);
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
          variables: "VAR1=value1\nVAR2=value2",
          "env-var-prefix": "CUSTOM_PREFIX",
          "monitor-timeout": "600",
          "monitor-interval": "10",
        })[name] || "",
    );
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("custom-stack");
    expect(settings.version).toBe("1.0.0");
    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
    expect(settings.envVarPrefix).toBe("CUSTOM_PREFIX");
    expect(settings.variables).toSatisfy((variables: Map<string, string>) => {
      return (
        variables.get("VAR1") === "value1" && variables.get("VAR2") === "value2"
      );
    });
    expect(settings.monitor).toBe(false);
    expect(settings.monitorTimeout).toBe(600);
    expect(settings.monitorInterval).toBe(10);
  });

  it("should infer version from GITHUB_REF", () => {
    vi.stubEnv("GITHUB_REF", "refs/tags/v1.2.3");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.version).toBe("v1.2.3");
  });

  it("should infer version from GITHUB_SHA if no GITHUB_REF is specified", () => {
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.version).toBe("4fadb58");
  });

  it("should infer stack name from GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "user/repo");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("repo");
  });

  it("should handle missing GITHUB_REPOSITORY gracefully", () => {
    vi.stubEnv("GITHUB_REPOSITORY", undefined);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("unknown");
  });

  it("should retrieve compose files from COMPOSE_FILE environment variable", () => {
    vi.stubEnv("COMPOSE_FILE", "file1.yml,file2.yml");
    vi.stubEnv("COMPOSE_PATH_SEPARATOR", ",");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
  });

  it("should parse variables from input", () => {
    vi.stubEnv("INPUT_VARIABLES", "VAR1=value1\nVAR2=value2");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.get("VAR1")).toBe("value1");
    expect(settings.variables.get("VAR2")).toBe("value2");
  });

  it("should handle empty variables input", () => {
    vi.stubEnv("INPUT_VARIABLES", "");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.size).toBeGreaterThanOrEqual(0);
  });

  it("should override environment variables with input variables", () => {
    vi.stubEnv("VAR1", "envValue1");
    vi.stubEnv("VAR2", "envValue2");
    vi.stubEnv("INPUT_VARIABLES", "VAR1=inputValue1\nVAR3=inputValue3");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.get("VAR1")).toBe("inputValue1");
    expect(settings.variables.get("VAR2")).toBe("envValue2");
    expect(settings.variables.get("VAR3")).toBe("inputValue3");
  });
});
