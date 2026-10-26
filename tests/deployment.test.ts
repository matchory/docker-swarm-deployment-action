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
      expect(monitoring.monitorDeployment).toHaveBeenCalledWith(settings, {
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
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
});
