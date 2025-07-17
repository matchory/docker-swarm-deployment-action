import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { dump } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import * as engine from "../src/engine.js";
import { defineSettings } from "../src/settings.js";

vi.mock("@actions/core");
vi.mock("@actions/exec");

const mockedExec = vi.mocked(exec);
const mockedCore = vi.mocked(core);

describe("engine", () => {
  const settings = defineSettings({
    composeFiles: ["docker-compose.yml"],
    envVarPrefix: "APP",
    keyInterpolation: false,
    manageVariables: true,
    monitor: true,
    monitorInterval: 5,
    monitorTimeout: 300,
    stack: "test-stack",
    strictVariables: false,
    variables: new Map(),
    version: "1.0.0",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    // Default mock implementation for exec to avoid errors on unhandled calls
    mockedExec.mockImplementation(async (_0, _1, options) => {
      if (options?.listeners?.stdout) {
        options.listeners.stdout(Buffer.from(""));
      }
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("deployStack", () => {
    it("should call docker stack deploy with correct arguments", async () => {
      const spec: ComposeSpec = {
        version: "3.8",
        services: { web: { image: "nginx" } },
      };
      const expectedArgs = [
        "stack",
        "deploy",
        "--prune",
        "--quiet",
        "--detach=true",
        "--with-registry-auth",
        "--resolve-image=always",
        "--compose-file",
        "-",
        settings.stack,
      ];
      const expectedStdin = dump(spec);

      await engine.deployStack(spec, settings);

      expect(mockedExec).toHaveBeenCalledWith("docker", expectedArgs, {
        input: Buffer.from(expectedStdin),
        silent: false,
        env: {
          MATCHORY_DEPLOYMENT_VERSION: settings.version,
          MATCHORY_DEPLOYMENT_STACK: settings.stack,
        },
        listeners: expect.any(Object),
      });
      expect(mockedCore.info).toHaveBeenCalledWith(
        `Deployed stack ${settings.stack}`,
      );
    });
  });

  describe("normalizeComposeSpecification", () => {
    const composeFiles = ["docker-compose.yml", "docker-compose.override.yml"];

    it("should call docker compose config and parse JSON", async () => {
      const mockOutput = JSON.stringify({
        services: { app: { image: "test" } },
      });
      mockedExec.mockImplementation(async (_0, _1, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from(mockOutput));
        }
        return 0;
      });

      const result = await engine.normalizeComposeSpecification(
        composeFiles,
        settings,
      );

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        [
          "compose",
          "config",
          "--compose-file=docker-compose.yml",
          "--compose-file=docker-compose.override.yml",
          "--format=json",
        ],
        expect.any(Object),
      );
      expect(result).toEqual({ services: { app: { image: "test" } } });
    });

    it("should allow to skip interpolation", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("{}"));

        return 0;
      });
      await engine.normalizeComposeSpecification(composeFiles, settings, true);
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["--no-interpolate"]),
        expect.any(Object),
      );
    });

    it("should handle --resolve-image-digests flag", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("{}"));

        return 0;
      });
      await engine.normalizeComposeSpecification(
        composeFiles,
        settings,
        false,
        true,
      );
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["--resolve-image-digests"]),
        expect.any(Object),
      );
    });

    it("should throw error on empty output", async () => {
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("")); // Empty output

        return 0;
      });
      await expect(
        engine.normalizeComposeSpecification(composeFiles, settings),
      ).rejects.toThrowError(/No content produced/);
    });

    it("should throw error on invalid JSON", async () => {
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("invalid json"));

        return 0;
      });
      await expect(
        engine.normalizeComposeSpecification(composeFiles, settings),
      ).rejects.toThrowError(/Failed to parse JSON output/);
    });
  });

  describe("normalizeStackSpecification", () => {
    const composeFiles = ["docker-compose.yml"];

    it("should call docker stack config and parse YAML", async () => {
      const mockOutput = `
version: '3.8'
services:
  web:
    image: nginx
`;
      mockedExec.mockImplementation(async (_0, _1, options) => {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from(mockOutput));
        }
        return 0;
      });

      const result = await engine.normalizeStackSpecification(
        composeFiles,
        settings,
      );

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["stack", "config", "--compose-file=docker-compose.yml"],
        expect.any(Object),
      );
      expect(result).toEqual({
        version: "3.8",
        services: { web: { image: "nginx" } },
      });
    });

    it("should handle --skip-interpolation flag", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("{}"));

        return 0;
      });
      await engine.normalizeStackSpecification(composeFiles, settings, true);
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["--skip-interpolation"]),
        expect.any(Object),
      );
    });

    it("should throw error on empty output", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("")); // Empty output

        return 0;
      });
      await expect(
        engine.normalizeStackSpecification(composeFiles, settings),
      ).rejects.toThrow(
        /Failed to load compose file\(s\): No content produced/
      );
    });

    it("should throw error on invalid YAML", async () => {
      // js-yaml load returns undefined for empty or invalid yaml like just ':'
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(":"));

        return 0;
      });
      await expect(
        engine.normalizeStackSpecification(composeFiles, settings),
      ).rejects.toThrowError(/Failed to parse YAML output/);
    });
  });

  describe("listServices", () => {
    const mockServiceMetadata = {
      ID: "abc",
      Name: "service1",
      Mode: "replicated",
      Replicas: "1/1",
      Image: "img",
      Ports: "",
    };
    const mockService = {
      ID: "abc",
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
      Version: { Index: 1 },
      Spec: { Name: "service1", Labels: {}, TaskTemplate: {} },
      Endpoint: {},
      UpdateStatus: { State: "completed" },
    };

    it("should list services without inspection", async () => {
      const mockOutput = JSON.stringify(mockServiceMetadata);
      mockedExec.mockImplementation(async (_0, args, options) => {
        if (args?.includes("ls")) {
          options?.listeners?.stdout?.(Buffer.from(mockOutput + "\n"));
        }
        return 0;
      });

      const services = await engine.listServices({ name: "service1" });

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "ls", "--format=json", "--filter", "name=service1"],
        expect.any(Object),
      );
      expect(services).toEqual([mockServiceMetadata]);
    });

    it("should list services with inspection", async () => {
      const mockLsOutput = JSON.stringify(mockServiceMetadata);
      const mockInspectOutput = JSON.stringify(mockService);

      mockedExec.mockImplementation(async (_0, args, options) => {
        if (args?.includes("ls")) {
          options?.listeners?.stdout?.(Buffer.from(mockLsOutput + "\n"));
        } else if (args?.includes("inspect")) {
          options?.listeners?.stdout?.(Buffer.from(mockInspectOutput));
        }
        return 0;
      });

      const services = await engine.listServices({ name: "service1" }, true);

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "ls", "--format=json", "--filter", "name=service1"],
        expect.any(Object),
      );
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "inspect", "--format=json", mockServiceMetadata.ID],
        expect.any(Object),
      );
      expect(services).toEqual([{ ...mockServiceMetadata, ...mockService }]);
    });

    it("should handle filters correctly", async () => {
      await engine.listServices({
        id: "abc",
        labels: { "com.example.foo": "bar" },
        mode: "replicated",
      });
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "--filter",
          "id=abc",
          "--filter",
          "label=com.example.foo=bar",
          "--filter",
          "mode=replicated",
        ]),
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.listServices({})).rejects.toThrowError(
        /Failed to list services/,
      );
    });
  });

  describe("inspectService", () => {
    it("should inspect a service and parse JSON", async () => {
      const mockService = { ID: "abc", Spec: { Name: "test" } };
      const mockOutput = JSON.stringify(mockService);
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput));
        return 0;
      });

      const service = await engine.inspectService("abc");

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "inspect", "--format=json", "abc"],
        expect.any(Object),
      );
      expect(service).toEqual(mockService);
    });

    it("should throw error on invalid JSON", async () => {
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("invalid json"));
        return 0;
      });
      await expect(engine.inspectService("abc")).rejects.toThrowError(
        /Failed to parse JSON output/,
      );
    });
  });

  describe("getServiceLogs", () => {
    it("should get service logs and parse them", async () => {
      const timestamp = new Date().toISOString();
      const mockOutput = `${timestamp} com.docker.swarm.node.id=foo,com.docker.swarm.service.id=bar INFO Some log message`;
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput));
        return 0;
      });

      const logs = await engine.getServiceLogs("abc", { tail: 10 });

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        [
          "service",
          "logs",
          "--raw",
          "--no-trunc",
          "--details",
          "--timestamps",
          "--tail=10",
          "abc",
        ],
        expect.any(Object),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        timestamp: new Date(timestamp),
        metadata: {
          "com.docker.swarm.node.id": "foo",
          "com.docker.swarm.service.id": "bar",
        },
        message: "INFO Some log message",
      });
    });

    it("should handle the since option", async () => {
      const sinceDate = new Date(Date.now() - 60_000); // 1 minute ago
      await engine.getServiceLogs("abc", { since: sinceDate });

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([`--since=${sinceDate.toISOString()}`]),
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.getServiceLogs("abc", {})).rejects.toThrowError(
        /Failed to get logs for service/,
      );
    });
  });

  describe("listSecrets", () => {
    it("should list secrets and parse labels", async () => {
      const mockSecret = {
        ID: "sec1",
        Name: "my_secret",
        Labels: "key1=value1,key2=value2",
        CreatedAt: "ts",
        UpdatedAt: "ts",
      };
      const mockOutput = JSON.stringify(mockSecret);
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput + "\n"));
        return 0;
      });

      const secrets = await engine.listSecrets({ name: "my_secret" });

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["secret", "ls", "--format=json", "--filter", "name=my_secret"],
        expect.any(Object),
      );
      expect(secrets).toHaveLength(1);
      expect(secrets[0]).toEqual({
        ...mockSecret,
        Labels: { key1: "value1", key2: "value2" },
      });
    });

    it("should handle filters correctly", async () => {
      await engine.listSecrets({
        id: "sec1",
        labels: ["label1", { key: "value" }],
      });
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "--filter",
          "id=sec1",
          "--filter",
          "label=label1",
          "--filter",
          "label=key=value",
        ]),
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.listSecrets({})).rejects.toThrowError(
        /Failed to list secrets/,
      );
    });
  });

  describe("listConfigs", () => {
    it("should list configs and parse labels", async () => {
      const mockConfig = {
        ID: "cfg1",
        Name: "my_config",
        Labels: "key1=value1,key2=value2",
        CreatedAt: "ts",
        UpdatedAt: "ts",
      };
      const mockOutput = JSON.stringify(mockConfig);
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput + "\n"));
        return 0;
      });

      const configs = await engine.listConfigs({ name: "my_config" });

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["config", "ls", "--format=json", "--filter", "name=my_config"],
        expect.any(Object),
      );
      expect(configs).toHaveLength(1);
      expect(configs[0]).toEqual({
        ...mockConfig,
        Labels: { key1: "value1", key2: "value2" },
      });
    });

    it("should handle filters correctly", async () => {
      await engine.listConfigs({ id: "cfg1", labels: { app: "test" } });
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "--filter",
          "id=cfg1",
          "--filter",
          "label=app=test",
        ]),
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.listConfigs({})).rejects.toThrowError(
        /Failed to list configs/,
      );
    });
  });

  describe("removeSecret", () => {
    it("should call docker secret rm", async () => {
      await engine.removeSecret("sec1");
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["secret", "rm", "sec1"],
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.removeSecret("sec1")).rejects.toThrowError(
        /Failed to remove secret/,
      );
    });
  });

  describe("removeConfig", () => {
    it("should call docker config rm", async () => {
      await engine.removeConfig("cfg1");
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["config", "rm", "cfg1"],
        expect.any(Object),
      );
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.removeConfig("cfg1")).rejects.toThrowError(
        /Failed to remove config/,
      );
    });
  });

  describe("error handling and edge cases", () => {
    it("should throw error if docker command fails", async () => {
      mockedExec.mockImplementationOnce(async () => {
        throw new Error("docker error");
      });
      await expect(
        engine.normalizeComposeSpecification(["docker-compose.yml"], settings)
      ).rejects.toThrow(/docker error/);
    });

    it("should throw error if YAML output is empty", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      });
      await expect(
        engine.normalizeStackSpecification(["docker-compose.yml"], settings)
      ).rejects.toThrow(
        /Failed to load compose file\(s\): No content produced/
      );
    });

    it("should handle parseFilter and parseLabelFilter edge cases", () => {
      expect(engine.parseFilter("label", ["foo", "bar"])).toEqual([
        "label=foo",
        "label=bar",
      ]);
      expect(engine.parseLabelFilter({ foo: "bar" })).toEqual(["foo=bar"]);
      expect(engine.parseLabelFilter(["foo", { bar: "baz" }])).toEqual([
        "foo",
        "bar=baz",
      ]);
    });
  });
});
