import { exec } from "@actions/exec";
import * as yaml from "js-yaml";
import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ComposeSpec,
  defineComposeSpec,
  interpolateSpec,
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
    keyInterpolation: false,
    manageVariables: true,
    monitor: false,
    monitorInterval: 5,
    monitorTimeout: 300,
    stack: "test-stack",
    strictVariables: false,
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
      vi.spyOn(utils, "exists").mockImplementation(
        async (path: string) => path === "docker-compose.yaml",
      );

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "docker-compose.yaml",
      ]);

      expect(utils.exists).toHaveBeenCalledTimes(11);
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.yml");
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
      expect(utils.exists).toHaveBeenCalledTimes(20);
    });

    it("should find and prefer compose.yaml over docker-compose.yaml", async () => {
      vi.spyOn(utils, "exists").mockImplementation(
        async (path: string) =>
          path === "compose.yaml" || path === "docker-compose.yaml",
      );

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.yaml",
      ]);

      expect(utils.exists).toHaveBeenCalledTimes(5);
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.yaml");
    });

    it("should find and prefer compose.yml over docker-compose.yml", async () => {
      vi.spyOn(utils, "exists").mockImplementation(
        async (path: string) =>
          path === "compose.yml" || path === "docker-compose.yml",
      );

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.yml",
      ]);

      expect(utils.exists).toHaveBeenCalledTimes(6);
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.prod.yml");
      expect(utils.exists).toHaveBeenCalledWith("compose.yaml");
      expect(utils.exists).toHaveBeenCalledWith("compose.yml");
    });

    it("should find and prefer compose.production.yaml with highest priority", async () => {
      vi.spyOn(utils, "exists").mockImplementation(
        async (path: string) =>
          path === "compose.production.yaml" ||
          path === "docker-compose.production.yaml" ||
          path === "compose.yaml" ||
          path === "docker-compose.yaml",
      );

      await expect(resolveComposeFiles(settings)).resolves.toEqual([
        "compose.production.yaml",
      ]);

      expect(utils.exists).toHaveBeenCalledTimes(1);
      expect(utils.exists).toHaveBeenCalledWith("compose.production.yaml");
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
          "--skip-interpolation",
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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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
        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, mockSettings);

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
        const result = await interpolateSpec(spec, mockSettings);

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

        const result = await interpolateSpec(spec, settingsWithDeploymentVars);

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

        const result = await interpolateSpec(spec, settingsWithDeploymentVars);

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
    });
  });

  describe("Stack Deployment", () => {
    const settings = defineSettings({
      composeFiles: ["docker-compose.yaml"],
      envVarPrefix: "DEPLOYMENT",
      keyInterpolation: false,
      manageVariables: true,
      monitor: false,
      monitorInterval: 5,
      monitorTimeout: 300,
      stack: "test-stack",
      strictVariables: false,
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
          env: {
            MATCHORY_DEPLOYMENT_STACK: "test-stack",
            MATCHORY_DEPLOYMENT_VERSION: "ebadf1",
          },
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
          env: {
            MATCHORY_DEPLOYMENT_STACK: "test-stack",
            MATCHORY_DEPLOYMENT_VERSION: "ebadf1",
          },
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
          env: {
            MATCHORY_DEPLOYMENT_STACK: "different-name",
            MATCHORY_DEPLOYMENT_VERSION: "abcd123",
            CUSTOM_VAR: "custom_value",
          },
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
