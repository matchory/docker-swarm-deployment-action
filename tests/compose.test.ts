import { exec } from "@actions/exec";
import * as yaml from "js-yaml";
import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ComposeSpec,
  defineComposeSpec,
  loadComposeSpecs,
  normalizeSpec,
  reconcileSpec,
  resolveComposeFiles,
  schemaVersion,
} from "../src/compose.js";
import { deployStack } from "../src/engine";
import { defineSettings } from "../src/settings.js";
import * as utils from "../src/utils.js";
import { processVariable } from "../src/variables.js";

const unlink = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());

vi.mock("@actions/core");
vi.mock("@actions/exec");
vi.mock("node:fs/promises", () => ({
  writeFile,
  readFile,
  unlink,
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
    manageVariables: true,
    monitorInterval: 5,
    monitor: false,
    stack: "test-stack",
    monitorTimeout: 300,
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
      vi.spyOn(utils, "exists").mockImplementation(
        async (path: string) => path === "docker-compose.yaml",
      );

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "docker-compose.yaml",
      ]);

      expect(utils.exists).toHaveBeenCalledTimes(5);
      expect(utils.exists).toHaveBeenCalledWith(
        "docker-compose.production.yaml",
      );
      expect(utils.exists).toHaveBeenCalledWith(
        "docker-compose.production.yml",
      );
      expect(utils.exists).toHaveBeenCalledWith("docker-compose.prod.yaml");
      expect(utils.exists).toHaveBeenCalledWith("docker-compose.prod.yml");
      expect(utils.exists).toHaveBeenCalledWith("docker-compose.yaml");
    });

    it("should throw an error if no compose file is found", async () => {
      vi.spyOn(utils, "exists").mockResolvedValue(false);
      await expect(resolveComposeFiles(settings)).rejects.toThrowError();
      expect(utils.exists).toHaveBeenCalledTimes(10);
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
      ).resolves.toEqual([composeSpec]);
    });

    it("should throw an error if the compose file does not have a services section", async () => {
      vi.spyOn(utils, "exists").mockResolvedValue(true);
      vi.mocked(exec).mockResolvedValue(0);
      vi.spyOn(yaml, "load").mockReturnValue({ version: "3.8" });

      await expect(
        loadComposeSpecs(["docker-compose.yaml"], settings),
      ).rejects.toThrowError();
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

      await expect(reconcileSpec(composeSpec, settings)).resolves.toEqual({
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

      await expect(reconcileSpec(composeSpec, settings)).resolves.toEqual({
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

      await expect(reconcileSpec(composeSpec, settings)).resolves.toEqual({
        version: "42",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
    });

    it("should throw an error if the compose file does not have a services section", async () => {
      await expect(
        reconcileSpec({ version: "3.8" } as ComposeSpec, settings),
      ).rejects.toThrowError();
    });

    it("should throw an error if the compose file has an empty services section", async () => {
      await expect(
        reconcileSpec(
          { version: "3.8", services: {} } as ComposeSpec,
          settings,
        ),
      ).rejects.toThrowError();
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

      await expect(reconcileSpec(composeSpec, settings)).resolves.toEqual({
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
        reconcileSpec(composeSpec, {
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
  });

  describe("Spec Normalization and Merging", () => {
    it("should normalize and merge the spec", async () => {
      const inputSpecs = [
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        {
          version: "3.8",
          services: {
            db: {
              image: "mysql:latest",
            },
          },
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
        options!.listeners!.stdout!(Buffer.from("output that can be parsed"));

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
        ],
        expect.anything(),
      );
      expect(yaml.load).toHaveBeenCalledWith("output that can be parsed", {
        filename: "docker-compose.yaml",
        json: true,
        onWarning: expect.toSatisfy((warning) => typeof warning === "function"),
      });
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

  describe("Stack Deployment", () => {
    const settings = defineSettings({
      composeFiles: ["docker-compose.yaml"],
      envVarPrefix: "DEPLOYMENT",
      manageVariables: true,
      monitorInterval: 5,
      monitor: false,
      stack: "test-stack",
      monitorTimeout: 300,
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
          env: undefined,
          input: Buffer.from(
            "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
          ),
          listeners: {
            stdout: expect.any(Function),
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
          env: undefined,
          input: Buffer.from(
            "version: '3.8'\nservices:\n  web:\n    image: nginx:latest\n",
          ),
          listeners: {
            stdout: expect.any(Function),
          },
          silent: false,
        },
      );
    });
  });
});
