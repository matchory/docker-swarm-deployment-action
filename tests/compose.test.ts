import * as crypto from "node:crypto";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ComposeSpec,
  defineComposeSpec,
  interpolateSpec,
  interpolateTypedFields,
  loadComposeSpecs,
  normalizeSpec,
  prepareSpec,
  readStackSettings,
  resolveComposeFiles,
  schemaVersion,
} from "../src/compose.js";
import * as engine from "../src/engine.js";
import { deployStack } from "../src/engine.js";
import * as envFile from "../src/env-file.js";
import { Tagged } from "../src/override-tags.js";
import * as reconcile from "../src/reconcile.js";
import { defineSettings } from "../src/settings.js";
import * as utils from "../src/utils.js";
import { processVariable } from "../src/variables.js";

const unlink = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());

vi.mock("@actions/core");
vi.mock("@actions/exec");
vi.mock("node:fs/promises", () => ({
  writeFile,
  readFile,
  unlink,
  readdir,
}));
vi.mock("node:crypto", {
  spy: true,
});
vi.mock("js-yaml");
vi.mock("../src/variables.js");

describe("Compose", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  const settings = defineSettings({
    envVarPrefix: "DEPLOYMENT",
    healthCheckWarnings: false,
    keyInterpolation: false,
    manageVariables: true,
    monitor: false,
    monitorInterval: 5,
    monitorTimeout: 300,
    secretValues: new Map(),
    stack: "test-stack",
    strictCompatibility: false,
    strictVariables: false,
    uploadComposeSpec: false,
    variables: new Map(),
    version: "ebadf1",
  });

  describe("Compose File Resolution", () => {
    it("should return composeFiles from settings if all exist", async () => {
      const composeFiles = [
        "docker-compose.yaml",
        "docker-compose.override.yaml",
      ];
      vi.spyOn(utils, "exists").mockResolvedValue(true);

      const settingsWithFiles = defineSettings({
        ...settings,
        composeFiles,
      });

      await expect(resolveComposeFiles(settingsWithFiles)).resolves.toEqual(
        composeFiles,
      );
      expect(utils.exists).toHaveBeenCalledTimes(2);
      expect(utils.exists).toHaveBeenCalledWith(composeFiles[0]);
      expect(utils.exists).toHaveBeenCalledWith(composeFiles[1]);
    });

    it("should throw an error if a compose file from settings does not exist", async () => {
      const composeFiles = [
        "docker-compose.yaml",
        "docker-compose.override.yaml",
      ];
      vi.spyOn(utils, "exists")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const settingsWithFiles = defineSettings({
        ...settings,
        composeFiles,
      });
      await expect(
        resolveComposeFiles(settingsWithFiles),
      ).rejects.toThrowError();

      expect(utils.exists).toHaveBeenCalledTimes(2);
      expect(utils.exists).toHaveBeenCalledWith(composeFiles[0]);
      expect(utils.exists).toHaveBeenCalledWith(composeFiles[1]);
    });

    it("should find and return a compose file in common locations", async () => {
      // Mock readdir to return docker-compose.yaml in the current directory
      vi.mocked(readdir).mockImplementation(async (path: string) => {
        if (path === ".") {
          return ["docker-compose.yaml"];
        }
        throw new Error("Directory not found");
      });

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "docker-compose.yaml",
      ]);

      // Should have called readdir for each unique directory
      expect(readdir).toHaveBeenCalledWith(".");
      expect(readdir).toHaveBeenCalledWith(".docker");
      expect(readdir).toHaveBeenCalledWith("docker");
    });

    it("should throw an error if no compose file is found", async () => {
      // Mock readdir to return empty arrays (no files found)
      vi.mocked(readdir).mockResolvedValue([]);

      await expect(resolveComposeFiles(settings)).rejects.toThrowError();

      // Should have tried to read each unique directory
      expect(readdir).toHaveBeenCalledWith(".");
      expect(readdir).toHaveBeenCalledWith(".docker");
      expect(readdir).toHaveBeenCalledWith("docker");
    });

    it("should find and prefer compose.yaml over docker-compose.yaml", async () => {
      // Mock readdir to return both files, but compose.yaml should be preferred
      vi.mocked(readdir).mockImplementation(async (path: string) => {
        if (path === ".") {
          return ["compose.yaml", "docker-compose.yaml"];
        }
        throw new Error("Directory not found");
      });

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.yaml",
      ]);

      expect(readdir).toHaveBeenCalledWith(".");
    });

    it("should find and prefer compose.yml over docker-compose.yml", async () => {
      // Mock readdir to return both files, but compose.yml should be preferred
      vi.mocked(readdir).mockImplementation(async (path: string) => {
        if (path === ".") {
          return ["compose.yml", "docker-compose.yml"];
        }
        throw new Error("Directory not found");
      });

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.yml",
      ]);

      expect(readdir).toHaveBeenCalledWith(".");
    });

    it("should find and prefer compose.production.yaml with highest priority", async () => {
      // Mock readdir to return multiple files, but compose.production.yaml should be preferred
      vi.mocked(readdir).mockImplementation(async (path: string) => {
        if (path === ".") {
          return [
            "compose.production.yaml",
            "docker-compose.production.yaml",
            "compose.yaml",
            "docker-compose.yaml",
          ];
        }
        throw new Error("Directory not found");
      });

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.production.yaml",
      ]);

      expect(readdir).toHaveBeenCalledWith(".");
    });

    describe("path containment", () => {
      it("should reject paths that escape the workspace via ..", async () => {
        vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["../../etc/passwd"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
          /outside the workspace/,
        );
      });

      it("should reject absolute paths outside the workspace", async () => {
        vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["/etc/passwd"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
          /outside the workspace/,
        );
      });

      it("should accept paths within the workspace", async () => {
        vi.stubEnv("GITHUB_WORKSPACE", process.cwd());
        vi.spyOn(utils, "exists").mockResolvedValue(true);
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["docker/compose.yaml"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).resolves.toEqual([
          "docker/compose.yaml",
        ]);
      });

      it("should accept paths when GITHUB_WORKSPACE is not set (falls back to cwd)", async () => {
        delete process.env.GITHUB_WORKSPACE;
        vi.spyOn(utils, "exists").mockResolvedValue(true);
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["compose.yaml"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).resolves.toEqual([
          "compose.yaml",
        ]);
      });

      it("should reject paths in a sibling directory sharing the workspace prefix", async () => {
        vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["/home/runner/work/repo-sibling/compose.yaml"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
          /outside the workspace/,
        );
      });

      it("should report all offending paths in the error message", async () => {
        vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
        const settingsWithFiles = defineSettings({
          ...settings,
          composeFiles: ["../secret.yaml", "/tmp/other.yaml"],
        });

        await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
          /secret\.yaml.*other\.yaml|other\.yaml.*secret\.yaml/,
        );
      });
    });
  });

  describe("Spec Loading", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should load and reconcile the compose specification", async () => {
      const composeSpec = defineComposeSpec({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load").mockReturnValue(composeSpec);

      await expect(
        loadComposeSpecs(["docker-compose.yaml"], settings),
      ).resolves.toEqual([{ spec: composeSpec, baseDir: "." }]);
    });

    it("should inline env files after loading all compose files", async () => {
      const composeSpec = defineComposeSpec({
        services: { web: { image: "nginx", env_file: "app.env" } },
      });
      const onUndefined = vi.fn();
      vi.spyOn(yaml, "load").mockReturnValue(composeSpec);
      vi.spyOn(envFile, "inlineEnvFiles").mockResolvedValue();

      await loadComposeSpecs(["docker/compose.yaml"], settings, onUndefined);

      expect(envFile.inlineEnvFiles).toHaveBeenCalledExactlyOnceWith(
        [{ spec: composeSpec, baseDir: "docker" }],
        settings,
        onUndefined,
      );
    });

    it("should throw an error if the compose file does not have a services section", async () => {
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load").mockReturnValue({ version: "3.8" });

      await expect(
        loadComposeSpecs(["docker-compose.yaml"], settings),
      ).rejects.toThrowError(
        'Compose file "docker-compose.yaml" has no services to deploy',
      );
    });

    it("should accept a file without services when another file has them", async () => {
      const servicesSpec = defineComposeSpec({
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
      });
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load")
        .mockReturnValueOnce(servicesSpec)
        .mockReturnValueOnce({ version: "3.8", networks: { shared: {} } });

      await expect(
        loadComposeSpecs(["compose.yaml", "compose.networks.yaml"], settings),
      ).resolves.toEqual([
        { spec: servicesSpec, baseDir: "." },
        {
          spec: { version: "3.8", services: {}, networks: { shared: {} } },
          baseDir: ".",
        },
      ]);
    });

    it("should give a file without a version the version another file declares", async () => {
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load")
        .mockReturnValueOnce({ services: { web: { image: "nginx" } } })
        .mockReturnValueOnce({ version: "3.9", services: {} });

      const specs = await loadComposeSpecs(["a.yaml", "b.yaml"], settings);

      expect(specs.map(({ spec }) => spec.version)).toEqual(["3.9", "3.9"]);
    });

    it("should throw an error if none of the compose files have services", async () => {
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load")
        .mockReturnValueOnce({ version: "3.8" })
        .mockReturnValueOnce({ version: "3.8", services: {} });

      await expect(
        loadComposeSpecs(["a.yaml", "b.yaml"], settings),
      ).rejects.toThrowError(
        "None of the Compose files (a.yaml, b.yaml) have any services to deploy",
      );
    });
  });

  describe("Schema Reconciliation", () => {
    it("should remove the stack name from the compose specification", async () => {
      const composeSpec = defineComposeSpec({
        name: "should be removed",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });

      await expect(prepareSpec(composeSpec, settings)).resolves.toEqual({
        version: schemaVersion,
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
    });

    it("should add the schema version to the compose specification", async () => {
      const composeSpec = defineComposeSpec({
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });

      await expect(prepareSpec(composeSpec, settings)).resolves.toEqual({
        version: schemaVersion,
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
    });

    it("should preserve an existing schema version in the compose specification", async () => {
      const composeSpec = defineComposeSpec({
        version: "42",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });

      await expect(prepareSpec(composeSpec, settings)).resolves.toEqual({
        version: "42",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
    });

    it("should default a missing services section to an empty one", async () => {
      await expect(
        prepareSpec({ version: "3.8" } as ComposeSpec, settings),
      ).resolves.toEqual({ version: "3.8", services: {} });
    });

    it("should process secrets and configs in the compose specification", async () => {
      const composeSpec = defineComposeSpec({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
        configs: {
          config1: {
            file: "config1.txt",
          },
        },
        secrets: {
          secret1: {
            file: "secret1.txt",
          },
        },
      });

      vi.mocked(processVariable)
        .mockResolvedValueOnce({
          name: "test-secret1-1.2.3",
          file: "processed-secret1.txt",
        })
        .mockResolvedValueOnce({
          name: "test-config1-1.2.3",
          file: "processed-config1.txt",
        });

      await expect(prepareSpec(composeSpec, settings)).resolves.toEqual({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
        configs: {
          config1: {
            name: "test-config1-1.2.3",
            file: "processed-config1.txt",
          },
        },
        secrets: {
          secret1: {
            name: "test-secret1-1.2.3",
            file: "processed-secret1.txt",
          },
        },
      });
    });

    it("should reject a merge tag on a managed secret entry with a clear error", async () => {
      const composeSpec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
        secrets: {
          secret1: new Tagged("!reset", "scalar", null),
        },
      } as unknown as ComposeSpec;

      await expect(prepareSpec(composeSpec, settings)).rejects.toThrow(
        /"!reset" merge tag.*not supported on secrets/s,
      );
      // The misleading env-var pipeline must never run for a tagged entry.
      expect(processVariable).not.toHaveBeenCalled();
    });

    it("should reject a merge tag on the whole configs section", async () => {
      const composeSpec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
        configs: new Tagged("!override", "mapping", new Map()),
      } as unknown as ComposeSpec;

      await expect(prepareSpec(composeSpec, settings)).rejects.toThrow(
        /"configs:" section uses the "!override" merge tag/,
      );
    });

    it("should reject a merge tag nested inside a managed secret entry", async () => {
      const composeSpec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
        secrets: {
          secret1: { file: new Tagged("!reset", "scalar", null) },
        },
      } as unknown as ComposeSpec;

      await expect(prepareSpec(composeSpec, settings)).rejects.toThrow(
        /Secret "secret1" uses the "!reset" merge tag/,
      );
      expect(processVariable).not.toHaveBeenCalled();
    });

    it("should not process secrets and configs if variable management is disabled", async () => {
      const composeSpec = defineComposeSpec({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
        configs: {
          config1: {
            file: "config1.txt",
          },
        },
        secrets: {
          secret1: {
            file: "secret1.txt",
          },
        },
      });

      await expect(
        prepareSpec(composeSpec, {
          ...settings,
          manageVariables: false,
        }),
      ).resolves.toEqual({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
        configs: {
          config1: {
            file: "config1.txt",
          },
        },
        secrets: {
          secret1: {
            file: "secret1.txt",
          },
        },
      });

      expect(processVariable).not.toHaveBeenCalled();
    });

    it("throws when reconciliation removes all services (non-tag path)", async () => {
      await expect(
        normalizeSpec(
          [
            {
              spec: defineComposeSpec({
                services: { ai: { provider: { type: "model-runner" } } },
              }),
              baseDir: ".",
            },
          ],
          { ...settings, manageVariables: false, strictCompatibility: false },
        ),
      ).rejects.toThrow(/All services were removed during reconciliation/);
    });

    it("accepts a file whose services are all removed when another file has services left", async () => {
      const outputSpec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
      };
      vi.spyOn(yaml, "load").mockReturnValue(outputSpec);
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("output that can be parsed"));

        return 0;
      });

      await expect(
        normalizeSpec(
          [
            {
              spec: defineComposeSpec({
                services: { web: { image: "nginx:latest" } },
              }),
              baseDir: ".",
            },
            {
              spec: defineComposeSpec({
                services: { ai: { provider: { type: "model-runner" } } },
              }),
              baseDir: ".",
            },
          ],
          { ...settings, manageVariables: false, strictCompatibility: false },
        ),
      ).resolves.toEqual(outputSpec);
    });
  });

  describe("Spec Normalization and Merging", () => {
    it("should normalize and merge the spec", async () => {
      const inputSpecs = [
        {
          spec: {
            version: "3.8",
            services: { web: { image: "nginx:latest" } },
          },
          baseDir: ".",
        },
        {
          spec: { version: "3.8", services: { db: { image: "mysql:latest" } } },
          baseDir: ".",
        },
      ];
      const outputSpec = {
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
          db: {
            image: "mysql:latest",
          },
        },
      };

      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("10000000-0000-4000-0000-000000000000")
        .mockReturnValueOnce("20000000-0000-4000-0000-000000000000");
      vi.spyOn(yaml, "load").mockReturnValue(outputSpec);
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("output that can be parsed"));

        return 0;
      });

      await expect(normalizeSpec(inputSpecs, settings)).resolves.toEqual(
        outputSpec,
      );

      expect(exec).toHaveBeenCalledWith(
        "docker",
        [
          "stack",
          "config",
          "--compose-file=docker-compose.generated.10000000-0000-4000-0000-000000000000.yaml",
          "--compose-file=docker-compose.generated.20000000-0000-4000-0000-000000000000.yaml",
          "--skip-interpolation",
        ],
        expect.anything(),
      );
      expect(yaml.load).toHaveBeenCalledWith("output that can be parsed", {
        filename: "docker-compose.yaml",
        json: true,
      });
    });

    it("should merge a spec without services into one that has them", async () => {
      const outputSpec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
        networks: { shared: {} },
      };
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("10000000-0000-4000-0000-000000000000")
        .mockReturnValueOnce("20000000-0000-4000-0000-000000000000");
      vi.spyOn(yaml, "load").mockReturnValue(outputSpec);
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("output that can be parsed"));

        return 0;
      });

      await expect(
        normalizeSpec(
          [
            {
              spec: {
                version: "3.8",
                services: { web: { image: "nginx:latest" } },
              },
              baseDir: ".",
            },
            {
              spec: { version: "3.8", services: {}, networks: { shared: {} } },
              baseDir: ".",
            },
          ],
          settings,
        ),
      ).resolves.toEqual(outputSpec);
    });

    it("writes generated files in the working directory (non-tag path)", async () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue(
        "10000000-0000-4000-0000-000000000000",
      );
      vi.spyOn(yaml, "load").mockReturnValue({
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
      });
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("output that can be parsed"));

        return 0;
      });

      await normalizeSpec(
        [
          {
            spec: { version: "3.8", services: { web: { image: "nginx" } } },
            baseDir: "docker",
          },
        ],
        settings,
      );

      // The non-tag path must keep writing to the working directory regardless
      // of baseDir, preserving the released path-resolution behavior.
      expect(writeFile.mock.calls.map(([path]) => path)).toContain(
        "docker-compose.generated.10000000-0000-4000-0000-000000000000.yaml",
      );
    });

    it("should throw an error if the docker stack config command fails", async () => {
      vi.mocked(exec).mockResolvedValue(1);

      await expect(normalizeSpec([], settings)).rejects.toThrowError();
    });

    it("should throw an error if the docker stack config command returns empty output", async () => {
      vi.mocked(exec).mockResolvedValue(0);

      await expect(normalizeSpec([], settings)).rejects.toThrowError();
    });

    it("should throw an error if the docker stack config command returns output that can't be parsed", async () => {
      vi.mocked(exec).mockResolvedValue(0);
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("foobar"));

        return 0;
      });

      await expect(normalizeSpec([], settings)).rejects.toThrowError();
    });

    it("should throw an error if the docker stack config command returns output that doesn't contain services", async () => {
      vi.mocked(exec).mockResolvedValue(0);
      vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("output that can be parsed"));

        return 0;
      });
      vi.spyOn(yaml, "load").mockReturnValue({
        version: "3.8",
      });

      await expect(normalizeSpec([], settings)).rejects.toThrowError();
    });
  });

  describe("normalizeSpec override-tag merge", () => {
    beforeEach(() => vi.clearAllMocks());

    it("restores the declared version and reports through the caller's warner", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue("");
      // `docker compose config` drops `version` and leaves typed fields as
      // strings when interpolation is off.
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx", deploy: { replicas: "${N}" } } },
      });
      const reconcileSpy = vi
        .spyOn(reconcile, "reconcileSwarmCompatibility")
        .mockResolvedValue(undefined);
      vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
        services: { web: { image: "nginx" } },
      });
      const onUndefined = vi.fn();

      const specs = [
        {
          spec: {
            version: "3.12",
            services: {
              web: {
                image: "nginx",
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await expect(normalizeSpec(specs, settings, onUndefined)).rejects.toThrow(
        /replicas must be an integer/,
      );

      expect(onUndefined).toHaveBeenCalledWith("N");
      expect(reconcileSpy).not.toHaveBeenCalled();

      vi.mocked(yaml.load).mockReturnValue({
        services: { web: { image: "nginx", deploy: { replicas: "2" } } },
      });

      await normalizeSpec(specs, settings, onUndefined);

      expect(reconcileSpy).toHaveBeenCalledWith(
        expect.objectContaining({ version: "3.12" }),
        settings,
      );
    });

    it("merges via docker compose then reconciles + normalizes when tags are present", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
        "services:\n  web:\n    image: nginx\n    restart: always\n",
      );
      // The merged, tag-free spec that `docker compose config` produced.
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx", restart: "always" } },
      });
      const reconcileSpy = vi.spyOn(reconcile, "reconcileSwarmCompatibility");
      const normalize = vi
        .spyOn(engine, "normalizeStackSpecification")
        .mockResolvedValue({ services: { web: { image: "nginx" } } });

      const specs = [
        {
          spec: {
            services: {
              web: {
                image: "nginx",
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await normalizeSpec(specs, settings);

      expect(engine.mergeComposeFiles).toHaveBeenCalled();
      // reconcile runs on the tag-free merged spec, translating restart.
      expect(reconcileSpy).toHaveBeenCalledWith(
        {
          services: {
            web: {
              image: "nginx",
              deploy: { restart_policy: { condition: "any" } },
            },
          },
        },
        settings,
      );
      // normalize runs on a single merged file.
      expect(normalize).toHaveBeenCalledWith(
        [expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/)],
        settings,
        true,
      );
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/),
      );
    });

    it("casts typed fields the merge emitted as strings", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue("");
      // `docker compose config --no-interpolate` emits `!override 3` as "3".
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx", deploy: { replicas: "3" } } },
      });
      const reconcileSpy = vi.spyOn(reconcile, "reconcileSwarmCompatibility");
      vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
        services: { web: { image: "nginx" } },
      });

      const specs = [
        {
          spec: {
            services: {
              web: {
                image: "nginx",
                deploy: { replicas: new Tagged("!override", "scalar", 3) },
              },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await normalizeSpec(specs, settings);

      expect(reconcileSpy).toHaveBeenCalledWith(
        { services: { web: { image: "nginx", deploy: { replicas: 3 } } } },
        settings,
      );
    });

    it("throws when tags are present but the compose plugin is missing", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(false);
      const merge = vi.spyOn(engine, "mergeComposeFiles");
      const specs = [
        {
          spec: {
            services: {
              web: { ports: new Tagged("!override", "sequence", []) },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await expect(normalizeSpec(specs, settings)).rejects.toThrow(
        /Docker Compose v2 plugin/,
      );
      expect(merge).not.toHaveBeenCalled();
    });

    it("uses docker stack config directly when no tags are present", async () => {
      const merge = vi.spyOn(engine, "mergeComposeFiles");
      vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
        services: { web: { image: "nginx" } },
      });

      const specs = [
        { spec: { services: { web: { image: "nginx" } } }, baseDir: "." },
      ] as unknown as Parameters<typeof normalizeSpec>[0];
      await normalizeSpec(specs, settings);

      expect(merge).not.toHaveBeenCalled();
      expect(engine.normalizeStackSpecification).toHaveBeenCalled();
    });

    it("writes the input spec beside its compose file so relative paths resolve", async () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue(
        "10000000-0000-4000-0000-000000000000",
      );
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
        "services:\n  web:\n    image: nginx\n",
      );
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx" } },
      });
      vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
        services: { web: { image: "nginx" } },
      });

      const specs = [
        {
          spec: {
            services: {
              web: {
                image: "nginx",
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: "docker",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await normalizeSpec(specs, settings);

      // On the tag path, reconcile has not inlined label_file yet, so the temp
      // file must sit in baseDir for `docker compose config` to resolve the
      // spec's relative paths against the compose file's own directory.
      expect(writeFile.mock.calls.map(([path]) => path)).toContain(
        "docker/docker-compose.generated.10000000-0000-4000-0000-000000000000.yaml",
      );
      // The baseDir-anchored temp file is the one handed to the compose merge.
      const [mergedInputs] = vi.mocked(engine.mergeComposeFiles).mock.calls[0];
      expect(mergedInputs[0]).toBe(
        "docker/docker-compose.generated.10000000-0000-4000-0000-000000000000.yaml",
      );
    });

    it("merges files from different directories, each written beside its source", async () => {
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("aaaaaaaa-0000-4000-0000-000000000000")
        .mockReturnValueOnce("bbbbbbbb-0000-4000-0000-000000000000")
        .mockReturnValueOnce("cccccccc-0000-4000-0000-000000000000");
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
        "services:\n  web:\n    image: nginx\n",
      );
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx" }, db: { image: "postgres" } },
      });
      vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
        services: { web: { image: "nginx" }, db: { image: "postgres" } },
      });

      const specs = [
        {
          spec: {
            services: {
              web: {
                image: "nginx",
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: "docker",
        },
        {
          spec: { services: { db: { image: "postgres" } } },
          baseDir: "config/stack",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await normalizeSpec(specs, settings);

      // Each input file is written beside its own compose file, and both are
      // handed to a single `docker compose config` invocation in order.
      const written = writeFile.mock.calls.map(([path]) => path);
      expect(written).toContain(
        "docker/docker-compose.generated.aaaaaaaa-0000-4000-0000-000000000000.yaml",
      );
      expect(written).toContain(
        "config/stack/docker-compose.generated.bbbbbbbb-0000-4000-0000-000000000000.yaml",
      );
      const [mergedInputs] = vi.mocked(engine.mergeComposeFiles).mock.calls[0];
      expect(mergedInputs.slice(0, 2)).toEqual([
        "docker/docker-compose.generated.aaaaaaaa-0000-4000-0000-000000000000.yaml",
        "config/stack/docker-compose.generated.bbbbbbbb-0000-4000-0000-000000000000.yaml",
      ]);
    });

    it("propagates strict-compatibility failures from the merged spec", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
        "services:\n  web:\n    image: nginx\n",
      );
      // The merged spec still carries a swarm-incompatible key (`develop`).
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { web: { image: "nginx", develop: { watch: [] } } },
      });
      const normalize = vi.spyOn(engine, "normalizeStackSpecification");

      const specs = [
        {
          spec: {
            services: {
              web: {
                image: "nginx",
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await expect(
        normalizeSpec(specs, { ...settings, strictCompatibility: true }),
      ).rejects.toThrow(/strict-compatibility is enabled/);
      // reconcile throws before the spec ever reaches docker stack config.
      expect(normalize).not.toHaveBeenCalled();
    });

    it("throws when reconciliation removes all services from the merged spec", async () => {
      vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
      vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
        "services:\n  ai:\n    provider:\n      type: model-runner\n",
      );
      // The only service in the merged spec is a provider, which reconcile drops.
      vi.spyOn(yaml, "load").mockReturnValue({
        services: { ai: { provider: { type: "model-runner" } } },
      });
      const normalize = vi.spyOn(engine, "normalizeStackSpecification");

      const specs = [
        {
          spec: {
            services: {
              ai: {
                provider: { type: "model-runner" },
                ports: new Tagged("!override", "sequence", []),
              },
            },
          },
          baseDir: ".",
        },
      ] as unknown as Parameters<typeof normalizeSpec>[0];

      await expect(
        normalizeSpec(specs, { ...settings, strictCompatibility: false }),
      ).rejects.toThrow(/All services were removed during reconciliation/);
      expect(normalize).not.toHaveBeenCalled();
    });
  });

  describe("Typed Field Interpolation", () => {
    const typedSettings = {
      variables: new Map([
        ["REPLICAS", "3"],
        ["PORT", "8080"],
        ["RATIO", "0.25"],
        ["FILES", "65535"],
        ["WORD", "many"],
      ]),
    };

    it("should interpolate and cast integer fields", () => {
      const spec: ComposeSpec = {
        services: {
          app: {
            image: "nginx:${TAG}",
            deploy: {
              replicas: "${MAIN_REPLICAS:-1}",
              update_config: { parallelism: "${REPLICAS}" },
              restart_policy: { max_attempts: "5" },
            },
            ports: [{ target: "80", published: "${PORT}" }, "${PORT}:443"],
            ulimits: { nproc: "${FILES}", nofile: { soft: "1024" } },
          },
        },
      };

      expect(interpolateTypedFields(spec, typedSettings)).toEqual({
        services: {
          app: {
            image: "nginx:${TAG}",
            deploy: {
              replicas: 1,
              update_config: { parallelism: 3 },
              restart_policy: { max_attempts: 5 },
            },
            ports: [{ target: 80, published: 8080 }, "${PORT}:443"],
            ulimits: { nproc: 65535, nofile: { soft: 1024 } },
          },
        },
      });
    });

    it("should interpolate and cast float and boolean fields", () => {
      const spec: ComposeSpec = {
        services: {
          app: {
            read_only: "${READ_ONLY:-yes}",
            deploy: { update_config: { max_failure_ratio: "${RATIO}" } },
            volumes: [{ type: "bind", read_only: "Off" }],
          },
        },
        networks: { backend: { external: "true" } },
        secrets: { token: { external: "${EXTERNAL:-no}" } },
      };

      expect(interpolateTypedFields(spec, typedSettings)).toEqual({
        services: {
          app: {
            read_only: true,
            deploy: { update_config: { max_failure_ratio: 0.25 } },
            volumes: [{ type: "bind", read_only: false }],
          },
        },
        networks: { backend: { external: true } },
        secrets: { token: { external: false } },
      });
    });

    it("should leave values that are already typed untouched", () => {
      const spec: ComposeSpec = {
        services: { app: { deploy: { replicas: 2 }, tty: false } },
      };

      expect(interpolateTypedFields(spec, typedSettings)).toEqual(spec);
    });

    it("should name the field and expression when a value cannot be cast", () => {
      const spec: ComposeSpec = {
        services: { app: { deploy: { replicas: "${WORD}" } } },
      };

      expect(() => interpolateTypedFields(spec, typedSettings)).toThrow(
        'services.app.deploy.replicas must be an integer, but "${WORD}" ' +
          "does not resolve to one",
      );
    });

    it("should keep merge tags and cast the typed fields they wrap", () => {
      const spec: ComposeSpec = {
        services: {
          app: {
            ports: new Tagged("!reset", "sequence", []),
            deploy: {
              replicas: new Tagged("!override", "scalar", "${REPLICAS}"),
              update_config: new Tagged(
                "!override",
                "mapping",
                new Map([["parallelism", "${REPLICAS}"]]),
              ),
            },
          },
        },
      };

      expect(interpolateTypedFields(spec, typedSettings)).toStrictEqual({
        services: {
          app: {
            ports: new Tagged("!reset", "sequence", []),
            deploy: {
              replicas: new Tagged("!override", "scalar", 3),
              update_config: new Tagged(
                "!override",
                "mapping",
                new Map([["parallelism", 3]]),
              ),
            },
          },
        },
      });
    });

    it("should name where a malformed reference in a typed field is", () => {
      const spec: ComposeSpec = {
        services: { app: { deploy: { replicas: "${REPLICAS" } } },
      };

      expect(() => interpolateTypedFields(spec, typedSettings)).toThrow(
        "services.app.deploy.replicas: Invalid interpolation format " +
          '"${REPLICAS"',
      );
    });

    it("should reject numbers Docker does not parse as floats", () => {
      const spec: ComposeSpec = {
        services: {
          app: { deploy: { update_config: { max_failure_ratio: "0x10" } } },
        },
      };

      expect(() => interpolateTypedFields(spec, typedSettings)).toThrow(
        "services.app.deploy.update_config.max_failure_ratio must be a number",
      );
    });

    it("should reject booleans Docker does not accept", () => {
      const spec: ComposeSpec = {
        services: { app: { privileged: "1" } },
      };

      expect(() => interpolateTypedFields(spec, typedSettings)).toThrow(
        'services.app.privileged must be a boolean, but "1" does not ' +
          "resolve to one",
      );
    });
  });

  describe("Undefined Variables", () => {
    const undefinedSettings = {
      keyInterpolation: false,
      variables: new Map([["TAG", "1.0"]]),
    };

    it("should warn once per undefined variable in the spec", () => {
      const spec: ComposeSpec = {
        services: {
          app: {
            image: "app:${UNSET_TAG}",
            environment: {
              A: "$UNSET_TAG",
              B: "${UNSET_TAG}-${TAG}",
              C: "${OTHER}",
            },
          },
        },
      };

      expect(interpolateSpec(spec, undefinedSettings)).toEqual({
        services: {
          app: {
            image: "app:",
            environment: { A: "", B: "-1.0", C: "" },
          },
        },
      });
      expect(vi.mocked(core.warning).mock.calls).toEqual([
        ['The "UNSET_TAG" variable is not set. Defaulting to a blank string.'],
        ['The "OTHER" variable is not set. Defaulting to a blank string.'],
      ]);
    });

    it("should not warn for variables with a default or alternative", () => {
      const spec: ComposeSpec = {
        services: {
          app: {
            image: "app:${VERSION:-latest}",
            command: "${A-a} ${B:+b} ${C+c} $${D}",
          },
        },
      };

      interpolateSpec(spec, undefinedSettings);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should warn for undefined variables in keys", () => {
      const spec: ComposeSpec = {
        services: { "app${SUFFIX}": { image: "app" } },
      };

      interpolateSpec(spec, { ...undefinedSettings, keyInterpolation: true });
      expect(core.warning).toHaveBeenCalledExactlyOnceWith(
        'The "SUFFIX" variable is not set. Defaulting to a blank string.',
      );
    });

    it("should warn once across typed field and spec interpolation", () => {
      const onUndefined = utils.warnAboutUndefinedVariables();
      const spec = interpolateTypedFields(
        {
          services: {
            app: { image: "app:${X}", deploy: { replicas: "1${X}" } },
          },
        },
        undefinedSettings,
        onUndefined,
      );

      expect(interpolateSpec(spec, undefinedSettings, onUndefined)).toEqual({
        services: { app: { image: "app:", deploy: { replicas: 1 } } },
      });
      expect(core.warning).toHaveBeenCalledExactlyOnceWith(
        'The "X" variable is not set. Defaulting to a blank string.',
      );
    });
  });

  describe("Spec Interpolation", () => {
    let mockSettings: ReturnType<typeof defineSettings>;

    beforeEach(() => {
      mockSettings = {
        ...settings,
        variables: new Map([
          ["SERVICE_NAME", "my-service"],
          ["IMAGE_TAG", "v1.0.0"],
          ["PORT", "8080"],
          ["NETWORK", "my-network"],
          ["VOLUME_PATH", "/data"],
          ["EMPTY_VAR", ""],
          ["ZERO_VAR", "0"],
        ]),
        keyInterpolation: false,
      };
    });

    describe("value interpolation", () => {
      it("should interpolate simple variables in values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${IMAGE_TAG}",
              ports: ["${PORT}:80"],
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
              ports: ["8080:80"],
            },
          },
        });
      });

      it("should interpolate variables with $VAR format", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:$IMAGE_TAG",
              container_name: "$SERVICE_NAME",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
              container_name: "my-service",
            },
          },
        });
      });

      it("should interpolate nested object values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              environment: {
                APP_PORT: "${PORT}",
                APP_NAME: "${SERVICE_NAME}",
              },
              labels: {
                "traefik.http.routers.app.rule":
                  "Host(`${SERVICE_NAME}.example.com`)",
              },
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              environment: {
                APP_PORT: "8080",
                APP_NAME: "my-service",
              },
              labels: {
                "traefik.http.routers.app.rule":
                  "Host(`my-service.example.com`)",
              },
            },
          },
        });
      });

      it("should interpolate array values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              command: ["sh", "-c", "echo ${SERVICE_NAME}"],
              volumes: ["${VOLUME_PATH}:/app/data"],
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              command: ["sh", "-c", "echo my-service"],
              volumes: ["/data:/app/data"],
            },
          },
        });
      });

      it("should handle default values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${MISSING_TAG:-latest}",
              container_name: "${MISSING_NAME-default-name}",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:latest",
              container_name: "default-name",
            },
          },
        });
      });

      it("should handle empty and zero values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${EMPTY_VAR:-fallback}",
              replicas: "${ZERO_VAR}",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:fallback",
              replicas: "0",
            },
          },
        });
      });
    });

    describe("key interpolation", () => {
      it("should not interpolate keys when keyInterpolation is false", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            "${SERVICE_NAME}": {
              image: "nginx:${IMAGE_TAG}",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            "${SERVICE_NAME}": {
              image: "nginx:v1.0.0",
            },
          },
        });
      });

      it("should interpolate keys when keyInterpolation is true", async () => {
        mockSettings.keyInterpolation = true;

        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            "${SERVICE_NAME}": {
              image: "nginx:${IMAGE_TAG}",
            },
          },
          networks: {
            "${NETWORK}": {
              driver: "bridge",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            "my-service": {
              image: "nginx:v1.0.0",
            },
          },
          networks: {
            "my-network": {
              driver: "bridge",
            },
          },
        });
      });

      it("should interpolate both keys and values when keyInterpolation is true", async () => {
        mockSettings.keyInterpolation = true;

        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            "${SERVICE_NAME}": {
              image: "nginx:${IMAGE_TAG}",
              environment: {
                "${SERVICE_NAME}_PORT": "${PORT}",
              },
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            "my-service": {
              image: "nginx:v1.0.0",
              environment: {
                "my-service_PORT": "8080",
              },
            },
          },
        });
      });

      it("should keep multi-line values intact when keyInterpolation is true", async () => {
        mockSettings.keyInterpolation = true;
        mockSettings.variables.set(
          "PEM",
          "-----BEGIN KEY-----\nabc\tdef\n-----END KEY-----\n",
        );

        const spec: ComposeSpec = {
          services: {
            app: {
              image: "nginx",
              environment: { KEY: "${PEM}" },
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result.services.app).toHaveProperty("environment", {
          KEY: "-----BEGIN KEY-----\nabc\tdef\n-----END KEY-----\n",
        });
      });

      it("should not let values inject keys when keyInterpolation is true", async () => {
        mockSettings.keyInterpolation = true;
        mockSettings.variables.set("Q", 'x","privileged":true,"y":"z');

        const spec: ComposeSpec = {
          services: {
            app: { image: "${Q}" },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result.services.app).toEqual({
          image: 'x","privileged":true,"y":"z',
        });
      });

      it("should preserve arrays, nested objects, and non-string scalars when keyInterpolation is true", async () => {
        mockSettings.keyInterpolation = true;

        const spec = {
          services: {
            "${SERVICE_NAME}": {
              image: "nginx:${IMAGE_TAG}",
              ports: ["${PORT}:80", { target: 80, published: 8080 }],
              deploy: { replicas: 2, labels: { enabled: true, gone: null } },
            },
          },
        } as unknown as ComposeSpec;

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          services: {
            "my-service": {
              image: "nginx:v1.0.0",
              ports: ["8080:80", { target: 80, published: 8080 }],
              deploy: { replicas: 2, labels: { enabled: true, gone: null } },
            },
          },
        });
      });

      it("should throw when interpolated keys collide", async () => {
        mockSettings.keyInterpolation = true;

        const spec: ComposeSpec = {
          services: {
            "my-service": { image: "nginx" },
            "${SERVICE_NAME}": { image: "redis" },
          },
        };

        expect(() => interpolateSpec(spec, mockSettings)).toThrow(
          /"my-service" more than once in services/,
        );
      });
    });

    describe("secrets and configs", () => {
      it("should interpolate secrets and configs", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${IMAGE_TAG}",
            },
          },
          secrets: {
            "file-secret": {
              file: "${VOLUME_PATH}/secret.txt",
            },
            "content-secret": {
              content:
                "secret=${SECRET_VALUE}\nclient_id=${CLIENT_ID}\n\nclient_secret=${CLIENT_SECRET}",
            },
          },
          configs: {
            "my-config": {
              file: "${VOLUME_PATH}/config.yml",
            },
          },
        };

        mockSettings.variables.set("SECRET_VALUE", "my-secret-value");
        mockSettings.variables.set("CLIENT_ID", "my-client-id");
        mockSettings.variables.set("CLIENT_SECRET", "my-client-secret");
        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
            },
          },
          secrets: {
            "file-secret": {
              file: "/data/secret.txt",
            },
            "content-secret": {
              content:
                "secret=my-secret-value\nclient_id=my-client-id\n\nclient_secret=my-client-secret",
            },
          },
          configs: {
            "my-config": {
              file: "/data/config.yml",
            },
          },
        });
      });
    });

    describe("edge cases", () => {
      it("should handle empty services object", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {},
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {},
        });
      });

      it("should handle undefined variables gracefully", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${UNDEFINED_VAR}",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:",
            },
          },
        });
      });

      it("should handle complex JSON structures", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${IMAGE_TAG}",
              deploy: {
                replicas: 3,
                resources: {
                  limits: {
                    memory: "512M",
                  },
                  reservations: {
                    memory: "256M",
                  },
                },
              },
            },
          },
          networks: {
            frontend: {
              driver: "overlay",
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
              deploy: {
                replicas: 3,
                resources: {
                  limits: {
                    memory: "512M",
                  },
                  reservations: {
                    memory: "256M",
                  },
                },
              },
            },
          },
          networks: {
            frontend: {
              driver: "overlay",
            },
          },
        });
      });

      it("should preserve non-string values", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${IMAGE_TAG}",
              deploy: {
                replicas: 3,
                restart_policy: {
                  condition: "on-failure",
                  delay: "5s",
                  max_attempts: 3,
                },
              },
              healthcheck: {
                test: ["CMD", "curl", "-f", "http://localhost:${PORT}/health"],
                interval: "30s",
                timeout: "10s",
                retries: 3,
              },
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
              deploy: {
                replicas: 3,
                restart_policy: {
                  condition: "on-failure",
                  delay: "5s",
                  max_attempts: 3,
                },
              },
              healthcheck: {
                test: ["CMD", "curl", "-f", "http://localhost:8080/health"],
                interval: "30s",
                timeout: "10s",
                retries: 3,
              },
            },
          },
        });
      });

      it("should handle escaped dollar signs", async () => {
        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${IMAGE_TAG}",
              environment: {
                LITERAL_DOLLAR: "$$NOT_A_VARIABLE",
                MIXED: "$$LITERAL and ${SERVICE_NAME}",
              },
            },
          },
        };

        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v1.0.0",
              environment: {
                LITERAL_DOLLAR: "$NOT_A_VARIABLE",
                MIXED: "$LITERAL and my-service",
              },
            },
          },
        });
      });
    });

    describe("error handling", () => {
      it("should handle malformed JSON gracefully", async () => {
        // This test ensures that if the interpolation produces invalid JSON,
        // the function will throw an appropriate error
        mockSettings.variables.set("MALFORMED", '{"incomplete": ');

        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:latest",
              labels: {
                config: "${MALFORMED}",
              },
            },
          },
        };

        // This should not throw because the interpolation itself is valid JSON
        const result = interpolateSpec(spec, mockSettings);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:latest",
              labels: {
                config: '{"incomplete": ',
              },
            },
          },
        });
      });
    });

    describe("MATCHORY deployment variables", () => {
      it("should interpolate MATCHORY_DEPLOYMENT_STACK and MATCHORY_DEPLOYMENT_VERSION", async () => {
        // Set up settings with the deployment variables
        const settingsWithDeploymentVars = {
          ...mockSettings,
          stack: "my-app-stack",
          version: "v2.1.0",
          variables: new Map([
            ...mockSettings.variables,
            ["MATCHORY_DEPLOYMENT_STACK", "my-app-stack"],
            ["MATCHORY_DEPLOYMENT_VERSION", "v2.1.0"],
          ]),
        };

        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            app: {
              image: "nginx:${MATCHORY_DEPLOYMENT_VERSION}",
              labels: {
                "com.example.stack": "${MATCHORY_DEPLOYMENT_STACK}",
                "com.example.version": "${MATCHORY_DEPLOYMENT_VERSION}",
              },
            },
          },
        };

        const result = interpolateSpec(spec, settingsWithDeploymentVars);

        expect(result).toEqual({
          version: "3.9",
          services: {
            app: {
              image: "nginx:v2.1.0",
              labels: {
                "com.example.stack": "my-app-stack",
                "com.example.version": "v2.1.0",
              },
            },
          },
        });
      });

      it("should interpolate MATCHORY_DEPLOYMENT variables in keys when keyInterpolation is enabled", async () => {
        const settingsWithDeploymentVars = {
          ...mockSettings,
          keyInterpolation: true,
          stack: "test-stack",
          version: "v1.0.0",
          variables: new Map([
            ...mockSettings.variables,
            ["MATCHORY_DEPLOYMENT_STACK", "test-stack"],
            ["MATCHORY_DEPLOYMENT_VERSION", "v1.0.0"],
          ]),
        };

        const spec: ComposeSpec = {
          version: "3.9",
          services: {
            "${MATCHORY_DEPLOYMENT_STACK}-app": {
              image: "nginx:${MATCHORY_DEPLOYMENT_VERSION}",
            },
          },
          networks: {
            "${MATCHORY_DEPLOYMENT_STACK}-network": {
              driver: "overlay",
            },
          },
        };

        const result = interpolateSpec(spec, settingsWithDeploymentVars);

        expect(result).toEqual({
          version: "3.9",
          services: {
            "test-stack-app": {
              image: "nginx:v1.0.0",
            },
          },
          networks: {
            "test-stack-network": {
              driver: "overlay",
            },
          },
        });
      });

      it.each([false, true])(
        "should name where a malformed reference is with keyInterpolation %s",
        (keyInterpolation) => {
          const spec: ComposeSpec = {
            services: {
              app: { image: "nginx", environment: { BROKEN: "a ${A.b}" } },
            },
          };

          expect(() =>
            interpolateSpec(spec, { ...mockSettings, keyInterpolation }),
          ).toThrow(
            'services.app.environment.BROKEN: Invalid interpolation format "${A.b}"',
          );
        },
      );

      it("should name where a malformed reference in a key is", () => {
        const spec: ComposeSpec = {
          services: { "${NAME": { image: "nginx" } },
        };

        expect(() =>
          interpolateSpec(spec, { ...mockSettings, keyInterpolation: true }),
        ).toThrow('services.${NAME: Invalid interpolation format "${NAME"');
      });

      it("should interpolate keys and values separately when keyInterpolation is enabled", () => {
        const settings = {
          ...mockSettings,
          keyInterpolation: true,
          variables: new Map([
            ["NAME", "app"],
            ["PASSWORD", 'p"a\\ss\nword'],
          ]),
        };
        const spec: ComposeSpec = {
          services: {
            "${NAME}": {
              image: "nginx",
              environment: {
                PASSWORD: "${PASSWORD}",
                AFTER: "}",
              },
            },
          },
        };

        expect(interpolateSpec(spec, settings)).toEqual({
          services: {
            app: {
              image: "nginx",
              environment: {
                PASSWORD: 'p"a\\ss\nword',
                AFTER: "}",
              },
            },
          },
        });
      });
    });
  });

  describe("Stack Deployment", () => {
    const settings = defineSettings({
      composeFiles: ["docker-compose.yaml"],
      envVarPrefix: "DEPLOYMENT",
      healthCheckWarnings: false,
      keyInterpolation: false,
      manageVariables: true,
      monitor: false,
      monitorInterval: 5,
      monitorTimeout: 300,
      secretValues: new Map(),
      stack: "test-stack",
      strictCompatibility: false,
      strictVariables: false,
      uploadComposeSpec: false,
      variables: new Map([
        ["MATCHORY_DEPLOYMENT_STACK", "test-stack"],
        ["MATCHORY_DEPLOYMENT_VERSION", "ebadf1"],
      ]),
      version: "ebadf1",
    });
    const composeSpec = defineComposeSpec({
      version: "3.8",
      services: {
        web: {
          image: "nginx:latest",
        },
      },
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should deploy the stack successfully", async () => {
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "dump").mockReturnValue(
        "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
      );

      await deployStack(composeSpec, settings);

      expect(exec).toHaveBeenCalledWith(
        "docker",
        [
          "stack",
          "deploy",
          "--prune",
          "--quiet",
          "--detach=true",
          "--with-registry-auth",
          "--resolve-image=always",
          "--compose-file",
          "-",
          "test-stack",
        ],
        {
          env: expect.objectContaining({
            MATCHORY_DEPLOYMENT_STACK: "test-stack",
            MATCHORY_DEPLOYMENT_VERSION: "ebadf1",
          }),
          input: Buffer.from(
            "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
          ),
          listeners: {
            stdout: expect.any(Function),
            stderr: expect.any(Function),
          },
          silent: false,
        },
      );
    });

    it("should handle errors during stack deployment", async () => {
      vi.mocked(exec).mockRejectedValue(new Error("Deployment failed"));
      vi.spyOn(yaml, "dump").mockReturnValue(
        "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
      );

      await expect(deployStack(composeSpec, settings)).rejects.toThrowError();

      expect(exec).toHaveBeenCalledWith(
        "docker",
        [
          "stack",
          "deploy",
          "--prune",
          "--quiet",
          "--detach=true",
          "--with-registry-auth",
          "--resolve-image=always",
          "--compose-file",
          "-",
          "test-stack",
        ],
        {
          env: expect.objectContaining({
            MATCHORY_DEPLOYMENT_STACK: "test-stack",
            MATCHORY_DEPLOYMENT_VERSION: "ebadf1",
          }),
          input: Buffer.from(
            "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
          ),
          listeners: {
            stdout: expect.any(Function),
            stderr: expect.any(Function),
          },
          silent: false,
        },
      );
    });

    it("should deploy the stack with a custom stack name and additional variables", async () => {
      const customSettings = defineSettings({
        ...settings,
        version: "abcd123",
        stack: "different-name",
        variables: new Map([
          ["CUSTOM_VAR", "custom_value"],
          ["MATCHORY_DEPLOYMENT_STACK", "different-name"],
          ["MATCHORY_DEPLOYMENT_VERSION", "abcd123"],
        ]),
      });

      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "dump").mockReturnValue(
        "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
      );

      await deployStack(composeSpec, customSettings);

      expect(exec).toHaveBeenCalledWith(
        "docker",
        [
          "stack",
          "deploy",
          "--prune",
          "--quiet",
          "--detach=true",
          "--with-registry-auth",
          "--resolve-image=always",
          "--compose-file",
          "-",
          "different-name",
        ],
        {
          env: expect.objectContaining({
            MATCHORY_DEPLOYMENT_STACK: "different-name",
            MATCHORY_DEPLOYMENT_VERSION: "abcd123",
            CUSTOM_VAR: "custom_value",
          }),
          input: Buffer.from(
            "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
          ),
          listeners: {
            stdout: expect.any(Function),
            stderr: expect.any(Function),
          },
          silent: false,
        },
      );
    });
  });

  describe("readStackSettings", () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof yaml>("js-yaml");
      vi.mocked(yaml.load).mockImplementation(actual.load);
    });

    it("should merge the settings blocks, later files winning", async () => {
      readFile.mockImplementation(
        async (filename: string) =>
          ({
            "base.yaml":
              "x-matchory-deployment:\n  monitor: true\n  monitor-timeout: 60\n" +
              "services:\n  web:\n    image: nginx\n",
            "override.yaml": "x-matchory-deployment:\n  monitor-timeout: 600\n",
            "plain.yaml": "services: {}\n",
          })[filename],
      );

      await expect(
        readStackSettings(["base.yaml", "override.yaml", "plain.yaml"]),
      ).resolves.toEqual({ monitor: true, "monitor-timeout": 600 });
    });

    it("should read the block without interpolating it", async () => {
      readFile.mockResolvedValue(
        "x-matchory-deployment:\n  env-var-prefix: ${PREFIX}\nservices: {}\n",
      );

      await expect(readStackSettings(["compose.yaml"])).resolves.toEqual({
        "env-var-prefix": "${PREFIX}",
      });
    });

    it("should ignore an empty block", async () => {
      readFile.mockResolvedValue("x-matchory-deployment:\nservices: {}\n");

      await expect(readStackSettings(["compose.yaml"])).resolves.toEqual({});
    });

    it("should reject a block that is not a mapping", async () => {
      readFile.mockResolvedValue(
        "x-matchory-deployment: [monitor]\nservices: {}\n",
      );

      await expect(readStackSettings(["compose.yaml"])).rejects.toThrow(
        '"x-matchory-deployment" in Compose file "compose.yaml" must be a ' +
          "mapping of settings.",
      );
    });
  });
});
