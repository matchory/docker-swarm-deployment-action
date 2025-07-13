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
        stack: "test-stack",
        version: "1.2.3",
        envVarPrefix: "",
        manageVariables: true,
        monitor: false,
        monitorTimeout: 0,
        monitorInterval: 0,
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
          name: "foo",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
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
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);

      await deploy(settings);

      expect(compose.resolveComposeFiles).toHaveBeenCalledWith(settings);
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["docker-compose.yaml"],
        settings,
      );
      expect(compose.normalizeSpec).toHaveBeenCalledWith(
        [
          {
            name: "foo",
            services: {
              web: {
                image: "nginx:latest",
              },
            },
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

    it("should monitor the deployed services post-deployment if enabled", async () => {
      const settings = defineSettings({
        stack: "test-stack",
        version: "1.2.3",
        envVarPrefix: "",
        manageVariables: true,
        monitor: true,
        monitorTimeout: 0,
        monitorInterval: 0,
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
          name: "foo",
          services: {
            web: {
              image: "nginx:latest",
            },
          },
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
      );
      expect(compose.normalizeSpec).toHaveBeenCalledWith(
        [
          {
            name: "foo",
            services: {
              web: {
                image: "nginx:latest",
              },
            },
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
      expect(monitoring.monitorDeployment).toHaveBeenCalledWith(settings);
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
});
