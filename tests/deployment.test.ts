import Dockerode from "dockerode";
import { dump } from "js-yaml";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as compose from "../src/compose.js";
import { createClient, deploy } from "../src/deployment.js";
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

const server = setupServer();

// Start server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));

// Close server after all tests
afterAll(() => server.close());

// Reset handlers after each test for test isolation
afterEach(() => server.resetHandlers());

describe("Deployment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe("Docker Engine Connection", () => {
    const settings = defineSettings({
      stack: "test-stack",
      version: "1.2.3",
      envVarPrefix: "",
      monitor: false,
      monitorTimeout: 0,
      monitorInterval: 0,
    });

    it("should connect to Docker Engine via DOCKER_HOST environment variable using tcp://", async () => {
      vi.stubEnv("DOCKER_HOST", "tcp://localhost:2375");
      server.use(
        http.get("http://localhost:2375/_ping", () => HttpResponse.text("OK")),
      );
      const client = createClient(settings);

      await expect(client.ping()).resolves.toEqual(Buffer.from("OK"));
    });

    it("should connect to Docker Engine via DOCKER_HOST environment variable using http://", async () => {
      vi.stubEnv("DOCKER_HOST", "http://localhost:3000");
      server.use(
        http.get("http://localhost:3000/_ping", () => HttpResponse.text("OK")),
      );
      const client = createClient(settings);

      await expect(client.ping()).resolves.toEqual(Buffer.from("OK"));
    });

    it("should connect to Docker Engine via DOCKER_HOST environment variable using https://", async () => {
      vi.stubEnv("DOCKER_HOST", "https://localhost:3000");
      server.use(
        http.get("http://localhost:3000/_ping", () => HttpResponse.text("OK")),
      );
      const client = createClient(settings);

      await expect(client.ping()).resolves.toEqual(Buffer.from("OK"));
    });

    it("should connect to Docker Engine via DOCKER_HOST environment variable using ssh://", async () => {
      vi.stubEnv("DOCKER_HOST", "ssh://user:pass@localhost:2222");
      server.use(
        http.get("http://localhost/_ping", () => HttpResponse.text("OK")),
      );
      const client = createClient(settings);

      await expect(client.ping()).resolves.toEqual(Buffer.from("OK"));
    });
  });

  describe("Deployment Process", () => {
    it("should perform an orderly deployment", async () => {
      const settings = defineSettings({
        stack: "test-stack",
        version: "1.2.3",
        envVarPrefix: "",
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
      vi.spyOn(compose, "normalizeComposeSpec").mockResolvedValue({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(compose, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);

      await deploy(settings);

      expect(compose.resolveComposeFiles).toHaveBeenCalledWith(settings);
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["docker-compose.yaml"],
        settings,
      );
      expect(compose.normalizeComposeSpec).toHaveBeenCalledWith(
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
      expect(compose.deployStack).toHaveBeenCalledWith(
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
        expect.anything(),
        settings,
      );
    });

    it("should monitor the deployed services post-deployment if enabled", async () => {
      const settings = defineSettings({
        stack: "test-stack",
        version: "1.2.3",
        envVarPrefix: "",
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
      vi.spyOn(compose, "normalizeComposeSpec").mockResolvedValue({
        version: "3.8",
        services: {
          web: {
            image: "nginx:latest",
          },
        },
      });
      vi.spyOn(compose, "deployStack").mockResolvedValue(undefined);
      vi.spyOn(monitoring, "monitorDeployment").mockResolvedValue(undefined);
      vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);

      await deploy(settings);

      expect(compose.resolveComposeFiles).toHaveBeenCalledWith(settings);
      expect(compose.loadComposeSpecs).toHaveBeenCalledWith(
        ["docker-compose.yaml"],
        settings,
      );
      expect(compose.normalizeComposeSpec).toHaveBeenCalledWith(
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
      expect(compose.deployStack).toHaveBeenCalledWith(
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
        expect.toSatisfy((client: unknown) => client instanceof Dockerode),
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
        expect.anything(),
        settings,
      );
    });
  });
});
