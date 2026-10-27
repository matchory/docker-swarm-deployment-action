import { dump } from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as compose from "../src/compose.js";
import { deploy } from "../src/deployment.js";
import * as engine from "../src/engine.js";
import * as monitoring from "../src/monitoring.js";
import { defineSettings } from "../src/settings.js";
import * as utils from "../src/utils.js";
import * as variables from "../src/variables.js";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
}));
vi.mock("../src/engine.js");

describe("Deployment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe("Deployment Process", () => {
    it("should perform an orderly deployment", async () => {
      const settings = defineSettings({
        envVarPrefix: "",
        healthCheckWarnings: false,
        keyInterpolation: false,
        manageVariables: true,
        monitor: false,
        monitorInterval: 0,
        monitorTimeout: 0,
        secretValues: new Map(),
        stack: "test-stack",
        strictCompatibility: false,
        strictVariables: false,
        uploadComposeSpec: false,
        variables: new Map(),
        version: "1.2.3",
      });

      vi.spyOn(utils, "exists").mockResolvedValue(true);
      readFile.mockResolvedValue(
        dump({
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        }),
      );

      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        {
          spec: {
            name: "foo",
            services: {
              web: {
                image: "nginx:latest",
              },
            },
          },
          baseDir: ".",
        },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(compose, "interpolateSpec").mockReturnValue({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(engine, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue();

      await deploy(settings);

      expect(compose.resolveComposeFiles).toHaveBeenCalledWith(settings);
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["docker-compose.yaml"],
        settings,
        expect.any(Function),
      );
      expect(compose.normalizeSpec).toHaveBeenCalledWith(
        [
          {
            spec: {
              name: "foo",
              services: {
                web: {
                  image: "nginx:latest",
                },
              },
            },
            baseDir: ".",
          },
        ],
        settings,
        expect.any(Function),
      );
      expect(compose.interpolateSpec).toHaveBeenCalledWith(
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        settings,
        expect.any(Function),
      );

      expect(engine.deployStack).toHaveBeenCalledWith(
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        settings,
      );
      expect(variables.pruneVariables).toHaveBeenCalledWith(
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        settings,
      );
      expect(variables.removeGeneratedVariableFiles).toHaveBeenCalled();
    });

    it("should cast variables in typed fields before normalizing", async () => {
      const settings = defineSettings({
        envVarPrefix: "",
        healthCheckWarnings: false,
        keyInterpolation: false,
        manageVariables: true,
        monitor: false,
        monitorInterval: 0,
        monitorTimeout: 0,
        secretValues: new Map(),
        stack: "test-stack",
        strictCompatibility: false,
        strictVariables: false,
        uploadComposeSpec: false,
        variables: new Map([["REPLICAS", "2"]]),
        version: "1.2.3",
      });
      const spec = {
        services: { web: { image: "nginx", deploy: { replicas: 2 } } },
      };

      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        {
          spec: {
            services: {
              web: { image: "nginx", deploy: { replicas: "${REPLICAS}" } },
            },
          },
          baseDir: ".",
        },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue(spec);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue();

      await deploy(settings);

      expect(compose.normalizeSpec).toHaveBeenCalledWith(
        [{ spec, baseDir: "." }],
        settings,
        expect.any(Function),
      );
    });

    it("should not prune variables if variable management is disabled", async () => {
      const settings = defineSettings({
        envVarPrefix: "",
        healthCheckWarnings: false,
        keyInterpolation: false,
        manageVariables: false,
        monitor: false,
        monitorInterval: 0,
        monitorTimeout: 0,
        secretValues: new Map(),
        stack: "test-stack",
        strictCompatibility: false,
        strictVariables: false,
        uploadComposeSpec: false,
        variables: new Map(),
        version: "1.2.3",
      });
      const spec = { services: { web: { image: "nginx:latest" } } };

      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        { spec, baseDir: "." },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue(spec);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue();

      await deploy(settings);

      expect(engine.deployStack).toHaveBeenCalled();
      expect(variables.pruneVariables).not.toHaveBeenCalled();
    });

    it("should monitor the deployed services post-deployment if enabled", async () => {
      const settings = defineSettings({
        envVarPrefix: "",
        healthCheckWarnings: false,
        keyInterpolation: false,
        manageVariables: true,
        monitor: true,
        monitorInterval: 0,
        monitorTimeout: 0,
        secretValues: new Map(),
        stack: "test-stack",
        strictCompatibility: false,
        strictVariables: false,
        uploadComposeSpec: false,
        variables: new Map(),
        version: "1.2.3",
      });

      vi.spyOn(utils, "exists").mockResolvedValue(true);
      readFile.mockResolvedValue(
        dump({
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        }),
      );

      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        {
          spec: {
            name: "foo",
            services: {
              web: {
                image: "nginx:latest",
              },
            },
          },
          baseDir: ".",
        },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(engine, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(monitoring, "monitorDeployment").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);

      await deploy(settings);

      expect(compose.resolveComposeFiles).toHaveBeenCalledWith(settings);
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["docker-compose.yaml"],
        settings,
        expect.any(Function),
      );
      expect(compose.normalizeSpec).toHaveBeenCalledWith(
        [
          {
            spec: {
              name: "foo",
              services: {
                web: {
                  image: "nginx:latest",
                },
              },
            },
            baseDir: ".",
          },
        ],
        settings,
        expect.any(Function),
      );
      expect(engine.deployStack).toHaveBeenCalledWith(
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        settings,
      );
      expect(monitoring.monitorDeployment).toHaveBeenCalledWith(
        settings,
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        new Map([
          [
            "web",
            { healthCheckWarnings: false, monitor: true, monitorTimeout: 0 },
          ],
        ]),
      );
      expect(variables.pruneVariables).toHaveBeenCalledWith(
        {
          version: "3.8",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
        },
        settings,
      );
    });
  });

  describe("Generated Variable Files", () => {
    const settings = defineSettings({
      envVarPrefix: "",
      healthCheckWarnings: false,
      keyInterpolation: false,
      manageVariables: true,
      monitor: false,
      monitorInterval: 0,
      monitorTimeout: 0,
      secretValues: new Map(),
      stack: "test-stack",
      strictCompatibility: false,
      strictVariables: false,
      uploadComposeSpec: false,
      variables: new Map(),
      version: "1.2.3",
    });

    const spec = {
      version: "3.8",
      services: { web: { image: "nginx:latest" } },
    };

    beforeEach(() => {
      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        { spec, baseDir: "." },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue(spec);
      vi.spyOn(compose, "interpolateSpec").mockReturnValue(spec);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue(
        undefined,
      );
    });

    it("should remove them when the deployment fails", async () => {
      vi.spyOn(engine, "deployStack").mockRejectedValue(
        new Error("Deployment failed"),
      );

      await expect(deploy(settings)).rejects.toThrowError("Deployment failed");
      expect(variables.removeGeneratedVariableFiles).toHaveBeenCalled();
    });
  });

  describe("Shared Volumes", () => {
    const settings = defineSettings({
      envVarPrefix: "",
      healthCheckWarnings: false,
      keyInterpolation: false,
      manageVariables: true,
      monitor: false,
      monitorInterval: 0,
      monitorTimeout: 0,
      secretValues: new Map(),
      stack: "web",
      strictCompatibility: false,
      strictVariables: false,
      uploadComposeSpec: false,
      variables: new Map([
        ["MATCHORY_DEPLOYMENT_STACK", "web"],
        ["OTHER", "other"],
      ]),
      version: "1.2.3",
    });

    const withVolumeName = (name: string) => {
      const spec = {
        version: "3.8",
        services: { web: { image: "nginx:latest" } },
        volumes: { data: { name } },
      };
      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "docker-compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        { spec, baseDir: "." },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue(spec);
      vi.spyOn(engine, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue();
    };

    it("should check the volume name after interpolation", async () => {
      withVolumeName("${MATCHORY_DEPLOYMENT_STACK}_shared");

      await expect(deploy(settings)).resolves.toBeDefined();
    });

    it("should reject an interpolated name of another stack's share", async () => {
      withVolumeName("${OTHER}_shared");

      await expect(deploy(settings)).rejects.toThrowError(
        /names "other_shared"/,
      );
      expect(engine.deployStack).not.toHaveBeenCalled();
    });
  });

  describe("Labels and Stack Settings", () => {
    const settings = defineSettings({
      deploymentLabels: { "com.matchory.deployment.version": "1.2.3" },
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
      version: "1.2.3",
    });

    const withSpec = (file: string, services: Record<string, unknown>) => {
      const spec = { version: "3.12", services };
      readFile.mockResolvedValue(file);
      vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue([
        "compose.yaml",
      ]);
      vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
        { spec, baseDir: "." },
      ]);
      vi.spyOn(compose, "normalizeSpec").mockResolvedValue(spec);
      vi.spyOn(engine, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(monitoring, "monitorDeployment").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);
      vi.spyOn(variables, "removeGeneratedVariableFiles").mockResolvedValue();
    };

    it("should deploy every service with the deployment labels", async () => {
      withSpec("services: {}", {
        web: { image: "nginx", deploy: { labels: { team: "web" } } },
      });

      const spec = await deploy(settings);

      expect(engine.deployStack).toHaveBeenCalledWith(
        {
          version: "3.12",
          services: {
            web: {
              image: "nginx",
              deploy: {
                labels: {
                  team: "web",
                  "com.matchory.deployment.version": "1.2.3",
                },
              },
            },
          },
        },
        settings,
      );
      expect(spec).toEqual(vi.mocked(engine.deployStack).mock.calls[0][0]);
    });

    it("should apply the stack settings of the Compose file", async () => {
      withSpec(
        "x-matchory-deployment:\n  monitor: true\n  monitor-timeout: 600\n",
        { web: { image: "nginx" } },
      );

      await deploy(settings);

      const resolved = { ...settings, monitor: true, monitorTimeout: 600 };
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["compose.yaml"],
        resolved,
        expect.any(Function),
      );
      expect(monitoring.monitorDeployment).toHaveBeenCalledWith(
        resolved,
        expect.anything(),
        new Map([
          [
            "web",
            { healthCheckWarnings: false, monitor: true, monitorTimeout: 600 },
          ],
        ]),
      );
    });

    it("should monitor a stack whose services opt in", async () => {
      withSpec("services: {}", {
        web: {
          image: "nginx",
          deploy: { labels: { "com.matchory.deployment.monitor": "true" } },
        },
      });

      await deploy(settings);

      expect(monitoring.monitorDeployment).toHaveBeenCalledOnce();
    });

    it("should not deploy with an invalid service label", async () => {
      withSpec("services: {}", {
        web: {
          image: "nginx",
          deploy: {
            labels: { "com.matchory.deployment.monitor-timeout": "5m" },
          },
        },
      });

      await expect(deploy(settings)).rejects.toThrow(
        /"com\.matchory\.deployment\.monitor-timeout" label of service "web"/,
      );
      expect(engine.deployStack).not.toHaveBeenCalled();
    });
  });
});
