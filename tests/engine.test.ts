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
    healthCheckWarnings: false,
    keyInterpolation: false,
    manageVariables: true,
    monitor: true,
    monitorInterval: 5,
    monitorTimeout: 300,
    secretValues: new Map(),
    stack: "test-stack",
    strictCompatibility: false,
    strictVariables: false,
    uploadComposeSpec: false,
    variables: new Map([
      ["MATCHORY_DEPLOYMENT_STACK", "test-stack"],
      ["MATCHORY_DEPLOYMENT_VERSION", "1.0.0"],
    ]),
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
        env: expect.objectContaining({
          MATCHORY_DEPLOYMENT_STACK: "test-stack",
          MATCHORY_DEPLOYMENT_VERSION: "1.0.0",
        }),
        listeners: expect.any(Object),
      });
      expect(mockedCore.info).toHaveBeenCalledWith(
        `Deployed stack ${settings.stack}`,
      );
    });

    it("should escape dollar signs in values so docker keeps them literal", async () => {
      const spec: ComposeSpec = {
        services: {
          web: {
            image: "nginx",
            healthcheck: { test: ["CMD-SHELL", "curl localhost:$PORT"] },
            environment: { $KEY: "p@$$w0rd", OTHER: "a$'b" },
          },
        },
      };

      await engine.deployStack(spec, settings);

      const { input } = mockedExec.mock.calls[0][2] ?? {};
      expect(input?.toString()).toBe(
        dump({
          services: {
            web: {
              image: "nginx",
              healthcheck: { test: ["CMD-SHELL", "curl localhost:$$PORT"] },
              // Docker never interpolates keys, so they are left alone
              environment: { $KEY: "p@$$$$w0rd", OTHER: "a$$'b" },
            },
          },
        }),
      );
      // The caller's spec is not modified
      expect(spec.services.web).toHaveProperty("healthcheck.test", [
        "CMD-SHELL",
        "curl localhost:$PORT",
      ]);
    });
  });

  describe("docker connection environment", () => {
    // `exclude-variables` keeps a variable out of interpolation; it must not
    // send these two commands to a different daemon than every other call.
    it.each([
      ["stack deploy", () => engine.deployStack({ services: {} }, settings)],
      [
        "stack config",
        () =>
          engine.normalizeStackSpecification(["compose.yaml"], settings, true),
      ],
    ])("keeps the process environment for %s", async (_, run) => {
      vi.stubEnv("DOCKER_HOST", "ssh://deploy@swarm.example");
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("services: {}\n"));
        return 0;
      });

      try {
        await run();
      } finally {
        vi.unstubAllEnvs();
      }

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            DOCKER_HOST: "ssh://deploy@swarm.example",
            MATCHORY_DEPLOYMENT_STACK: "test-stack",
          }),
        }),
      );
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
        /Failed to load compose file\(s\): No content produced/,
      );
    });

    it("should throw error on invalid YAML", async () => {
      // An unclosed flow mapping is invalid YAML and makes js-yaml throw
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("{ a: b"));

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
          options?.listeners?.stdout?.(Buffer.from(`${mockOutput}\n`));
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
          options?.listeners?.stdout?.(Buffer.from(`${mockLsOutput}\n`));
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

    it("should inspect all services in one call, matching short IDs", async () => {
      const metadata = [
        { ...mockServiceMetadata, ID: "abc", Name: "service1" },
        { ...mockServiceMetadata, ID: "def", Name: "service2" },
      ];
      // `service ls` prints short IDs, `service inspect` full ones, and the
      // order of the inspect output is not relied upon.
      const inspected = [
        { ...mockService, ID: "def0000000000000000000000" },
        { ...mockService, ID: "abc0000000000000000000000" },
      ];

      mockedExec.mockImplementation(async (_0, args, options) => {
        const output = args?.includes("ls")
          ? metadata.map((item) => JSON.stringify(item)).join("\n")
          : JSON.stringify(inspected);
        options?.listeners?.stdout?.(Buffer.from(`${output}\n`));
        return 0;
      });

      const services = await engine.listServices({}, true);

      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "inspect", "--format=json", "abc", "def"],
        expect.any(Object),
      );
      expect(services.map(({ ID, Name }) => [Name, ID])).toEqual([
        ["service1", "abc0000000000000000000000"],
        ["service2", "def0000000000000000000000"],
      ]);
    });

    it("should not inspect when no services exist", async () => {
      mockedExec.mockImplementation(async () => 0);

      await expect(engine.listServices({}, true)).resolves.toEqual([]);
      expect(mockedExec).toHaveBeenCalledTimes(1);
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

    it("should throw error on invalid inspect JSON", async () => {
      mockedExec.mockImplementation(async (_0, args, options) => {
        const output = args?.includes("ls")
          ? JSON.stringify(mockServiceMetadata)
          : "invalid json";
        options?.listeners?.stdout?.(Buffer.from(output));
        return 0;
      });
      await expect(engine.listServices({}, true)).rejects.toThrowError(
        /could not be parsed as JSON/,
      );
    });

    it("should report a service missing from the inspect output", async () => {
      mockedExec.mockImplementation(async (_0, args, options) => {
        const output = args?.includes("ls")
          ? JSON.stringify(mockServiceMetadata)
          : "[]";
        options?.listeners?.stdout?.(Buffer.from(output));
        return 0;
      });
      await expect(engine.listServices({}, true)).rejects.toThrowError(
        /was not found on the Swarm/,
      );
    });
  });

  describe("getServiceLogs", () => {
    it("should get service logs and parse them", async () => {
      const timestamp = new Date().toISOString();
      const mockOutput = `${timestamp} INFO Some log message`;
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
          "--timestamps",
          "--tail=10",
          "abc",
        ],
        expect.any(Object),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        timestamp: new Date(timestamp),
        message: "INFO Some log message",
      });
    });

    it("should handle empty log lines", async () => {
      const mockOutput = `\n\n`;
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput));
        return 0;
      });

      const logs = await engine.getServiceLogs("abc", {});

      expect(logs).toHaveLength(0);
    });

    it("should handle invalid timestamps in log lines", async () => {
      const mockOutput = `invalid-timestamp Some log message`;
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(mockOutput));
        return 0;
      });

      const logs = await engine.getServiceLogs("abc", {});

      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        timestamp: null,
        message: "Some log message",
      });
      expect(mockedCore.warning).toHaveBeenCalledWith(
        expect.stringMatching(/Unexpected invalid timestamp/),
      );
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

  describe("listServiceTasks", () => {
    it("should list tasks for a service and parse JSON", async () => {
      const mockTask = {
        ID: "task1",
        Name: "api.1",
        Image: "registry/api:v2",
        Node: "worker-1",
        DesiredState: "Shutdown",
        CurrentState: "Failed 2 minutes ago",
        Error: "task: non-zero exit (1)",
        Ports: "",
      };
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(
          Buffer.from(`${JSON.stringify(mockTask)}\n`),
        );
        return 0;
      });

      const tasks = await engine.listServiceTasks("svc1");

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["service", "ps", "--format=json", "--no-trunc", "svc1"],
        expect.any(Object),
      );
      expect(tasks).toEqual([mockTask]);
    });

    it("should return multiple tasks in order", async () => {
      const task1 = {
        ID: "t1",
        Name: "api.1",
        Image: "img",
        Node: "n1",
        DesiredState: "Shutdown",
        CurrentState: "Failed 3 minutes ago",
        Error: "task: non-zero exit (1)",
        Ports: "",
      };
      const task2 = {
        ID: "t2",
        Name: "api.2",
        Image: "img",
        Node: "n2",
        DesiredState: "Running",
        CurrentState: "Running 1 minute ago",
        Error: "",
        Ports: "",
      };
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(
          Buffer.from(`${JSON.stringify(task1)}\n${JSON.stringify(task2)}\n`),
        );
        return 0;
      });

      const tasks = await engine.listServiceTasks("svc1");
      expect(tasks).toHaveLength(2);
      expect(tasks[0].ID).toBe("t1");
      expect(tasks[1].ID).toBe("t2");
    });

    it("should throw error on exec failure", async () => {
      mockedExec.mockRejectedValue(new Error("Docker error"));
      await expect(engine.listServiceTasks("svc1")).rejects.toThrowError(
        /Failed to list tasks/,
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
        options?.listeners?.stdout?.(Buffer.from(`${mockOutput}\n`));
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

    it("should replace relative timestamps with exact ones", async () => {
      mockedExec.mockImplementation(async (_0, args, options) => {
        const line =
          args?.[1] === "ls"
            ? {
                ID: "sec1",
                Name: "my_secret",
                Labels: "",
                CreatedAt: "2 hours ago",
                UpdatedAt: "2 hours ago",
              }
            : {
                ID: "sec1",
                CreatedAt: "2026-03-07T17:44:28.484060447Z",
                UpdatedAt: "2026-03-07T17:44:28.484060447Z",
              };
        options?.listeners?.stdout?.(Buffer.from(`${JSON.stringify(line)}\n`));
        return 0;
      });

      const secrets = await engine.listSecrets({});

      expect(mockedExec).toHaveBeenLastCalledWith(
        "docker",
        ["secret", "inspect", expect.any(String), "sec1"],
        expect.any(Object),
      );
      expect(secrets[0].CreatedAt).toBe("2026-03-07T17:44:28.484060447Z");
      expect(secrets[0].UpdatedAt).toBe("2026-03-07T17:44:28.484060447Z");
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
        options?.listeners?.stdout?.(Buffer.from(`${mockOutput}\n`));
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

  describe("isComposePluginAvailable", () => {
    it("returns true when `docker compose version` succeeds", async () => {
      mockedExec.mockResolvedValue(0);
      await expect(engine.isComposePluginAvailable()).resolves.toBe(true);
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["compose", "version"],
        expect.any(Object),
      );
    });

    it("returns false when the command errors", async () => {
      mockedExec.mockRejectedValue(new Error("unknown command"));
      await expect(engine.isComposePluginAvailable()).resolves.toBe(false);
    });
  });

  describe("mergeComposeFiles", () => {
    it("runs `docker compose … config --no-interpolate` and returns stdout", async () => {
      const merged = "services:\n  web:\n    image: nginx\n";
      mockedExec.mockImplementation(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(merged));
        return 0;
      });

      await expect(
        engine.mergeComposeFiles(["base.yaml", "override.yaml"]),
      ).resolves.toBe(merged);

      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        [
          "compose",
          "--file",
          "base.yaml",
          "--file",
          "override.yaml",
          "config",
          "--no-interpolate",
        ],
        expect.any(Object),
      );
    });
  });

  describe("error handling and edge cases", () => {
    it("should throw error if docker command fails", async () => {
      mockedExec.mockImplementationOnce(async () => {
        throw new Error("docker error");
      });
      await expect(
        engine.normalizeStackSpecification(["docker-compose.yml"], settings),
      ).rejects.toThrow(/docker error/);
    });

    it("should throw error if YAML output is empty", async () => {
      mockedExec.mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      });
      await expect(
        engine.normalizeStackSpecification(["docker-compose.yml"], settings),
      ).rejects.toThrow(
        /Failed to load compose file\(s\): No content produced/,
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
