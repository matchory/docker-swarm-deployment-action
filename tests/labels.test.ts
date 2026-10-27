import { describe, expect, it } from "vitest";
import {
  addDeploymentLabels,
  inferDeploymentLabels,
  listValue,
  parseBoolean,
  parseSeconds,
  resolveServiceOptions,
} from "../src/labels.js";

describe("Labels", () => {
  const settings = {
    healthCheckWarnings: true,
    monitor: false,
    monitorTimeout: 300,
  };

  describe("resolveServiceOptions", () => {
    it("should use the stack-wide settings for services without labels", () => {
      const options = resolveServiceOptions(
        { services: { web: { image: "nginx" }, db: null } },
        settings,
      );

      expect(options).toEqual(
        new Map([
          ["web", settings],
          ["db", settings],
        ]),
      );
    });

    it("should let service labels override the stack-wide settings", () => {
      const options = resolveServiceOptions(
        {
          services: {
            web: {
              deploy: {
                labels: {
                  "com.matchory.deployment.monitor": "true",
                  "com.matchory.deployment.monitor-timeout": "900",
                  "com.matchory.deployment.health-check-warnings": "false",
                },
              },
            },
            api: { image: "node" },
          },
        },
        settings,
      );

      expect(options.get("web")).toEqual({
        healthCheckWarnings: false,
        monitor: true,
        monitorTimeout: 900,
      });
      expect(options.get("api")).toEqual(settings);
    });

    it("should let a service opt out of stack-wide monitoring", () => {
      const options = resolveServiceOptions(
        {
          services: {
            migrate: {
              deploy: { labels: ["com.matchory.deployment.monitor=false"] },
            },
          },
        },
        { ...settings, monitor: true },
      );

      expect(options.get("migrate")?.monitor).toBe(false);
    });

    it("should ignore container labels", () => {
      const options = resolveServiceOptions(
        {
          services: {
            web: { labels: { "com.matchory.deployment.monitor": "true" } },
          },
        },
        settings,
      );

      expect(options.get("web")?.monitor).toBe(false);
    });

    it.each([
      ["com.matchory.deployment.monitor", "yes", /must be true or false/],
      [
        "com.matchory.deployment.health-check-warnings",
        "",
        /must be true or false/,
      ],
      [
        "com.matchory.deployment.monitor-timeout",
        "10m",
        /must be a positive whole number of seconds/,
      ],
      [
        "com.matchory.deployment.monitor-timeout",
        "0",
        /must be a positive whole number of seconds/,
      ],
    ])('should reject %s="%s"', (label, value, message) => {
      expect(() =>
        resolveServiceOptions(
          { services: { web: { deploy: { labels: { [label]: value } } } } },
          settings,
        ),
      ).toThrow(message);
    });

    it("should name the service and label in the error", () => {
      expect(() =>
        resolveServiceOptions(
          {
            services: {
              web: {
                deploy: {
                  labels: { "com.matchory.deployment.monitor": "maybe" },
                },
              },
            },
          },
          settings,
        ),
      ).toThrow(
        'The "com.matchory.deployment.monitor" label of service "web" must ' +
          'be true or false, but is "maybe".',
      );
    });
  });

  describe("addDeploymentLabels", () => {
    const labels = {
      "com.matchory.deployment.version": "1.2.3",
      "com.matchory.deployment.commit": "abc",
    };

    it("should add the labels to every service", () => {
      const spec = addDeploymentLabels(
        { version: "3.12", services: { web: { image: "nginx" }, db: null } },
        labels,
      );

      expect(spec).toEqual({
        version: "3.12",
        services: {
          web: { image: "nginx", deploy: { labels } },
          db: { deploy: { labels } },
        },
      });
    });

    it("should keep existing service labels and deploy settings", () => {
      const spec = addDeploymentLabels(
        {
          services: {
            web: {
              labels: { container: "label" },
              deploy: { replicas: 2, labels: ["team=web"] },
            },
          },
        },
        labels,
      );

      expect(spec.services.web).toEqual({
        labels: { container: "label" },
        deploy: { replicas: 2, labels: { team: "web", ...labels } },
      });
    });

    it("should replace a label of the same name", () => {
      const spec = addDeploymentLabels(
        {
          services: {
            web: {
              deploy: { labels: { "com.matchory.deployment.commit": "old" } },
            },
          },
        },
        labels,
      );

      expect(spec.services.web).toEqual({ deploy: { labels } });
    });

    it("should not modify the given spec", () => {
      const original = {
        services: { web: { deploy: { labels: { a: "b" } } } },
      };

      addDeploymentLabels(original, labels);

      expect(original).toEqual({
        services: { web: { deploy: { labels: { a: "b" } } } },
      });
    });

    it("should leave the spec alone without labels to add", () => {
      const original = { services: { web: { image: "nginx" } } };

      expect(addDeploymentLabels(original, {})).toBe(original);
    });
  });

  describe("inferDeploymentLabels", () => {
    it("should describe the workflow run", () => {
      expect(
        inferDeploymentLabels("v1.2.3", {
          GITHUB_SHA: "4fadb584c2bad24be4467665cc6874dc57c2034e",
          GITHUB_REF: "refs/tags/v1.2.3",
          GITHUB_ACTOR: "octocat",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "my-org/my-app",
          GITHUB_RUN_ID: "42",
        }),
      ).toEqual({
        "com.matchory.deployment.version": "v1.2.3",
        "com.matchory.deployment.commit":
          "4fadb584c2bad24be4467665cc6874dc57c2034e",
        "com.matchory.deployment.ref": "refs/tags/v1.2.3",
        "com.matchory.deployment.run-url":
          "https://github.com/my-org/my-app/actions/runs/42",
        "com.matchory.deployment.actor": "octocat",
      });
    });

    it("should leave out what the environment does not provide", () => {
      expect(
        inferDeploymentLabels("1.0.0", {
          GITHUB_REPOSITORY: "my-org/my-app",
          GITHUB_RUN_ID: "42",
        }),
      ).toEqual({ "com.matchory.deployment.version": "1.0.0" });
    });
  });

  describe("parseBoolean", () => {
    it.each([
      [true, true],
      [false, false],
      ["true", true],
      ["True", true],
      ["TRUE", true],
      ["false", false],
      ["False", false],
      ["FALSE", false],
      ["yes", undefined],
      ["1", undefined],
      [1, undefined],
      [null, undefined],
    ])("should parse %j as %j", (value, expected) => {
      expect(parseBoolean(value)).toBe(expected);
    });
  });

  describe("listValue", () => {
    it.each([
      ["debug, seed", ["debug", "seed"]],
      ["debug\nseed\n", ["debug", "seed"]],
      ["*", ["*"]],
      [
        ["debug", "seed"],
        ["debug", "seed"],
      ],
      [[], []],
      [["debug", 1], undefined],
      [true, undefined],
      [null, undefined],
    ])("should parse %j as %j", (value, expected) => {
      expect(listValue.parse(value)).toEqual(expected);
    });
  });

  describe("parseSeconds", () => {
    it.each([
      [300, 300],
      ["300", 300],
      ["0", undefined],
      [0, undefined],
      [-5, undefined],
      [1.5, undefined],
      ["5.9", undefined],
      ["10s", undefined],
      ["1e3", undefined],
      [true, undefined],
      ["", undefined],
    ])("should parse %j as %j", (value, expected) => {
      expect(parseSeconds(value)).toBe(expected);
    });
  });
});
