import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findServiceHealthCheck,
  formatHealthCheck,
  validateHealthChecks,
} from "../src/healthcheck.js";

vi.mock("@actions/core");

describe("Health Check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("validateHealthChecks", () => {
    it("should warn for services without health checks", () => {
      validateHealthChecks(
        {
          services: {
            web: { image: "nginx" },
            api: { image: "node" },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        'Service "web" has no health check defined',
      );
      expect(core.warning).toHaveBeenCalledWith(
        'Service "api" has no health check defined',
      );
    });

    it("should warn for services with test: NONE", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: { test: "NONE" },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        'Service "web" has no health check defined',
      );
    });

    it("should warn for services with test: ['NONE']", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: { test: ["NONE"] },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        'Service "web" has no health check defined',
      );
    });

    it("should warn for services with disable: true", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: { disable: true },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        'Service "web" has no health check defined',
      );
    });

    it("should not warn for services with valid health checks", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: {
                test: ["CMD-SHELL", "curl -f http://localhost/health"],
                interval: "30s",
                timeout: "10s",
                retries: 3,
                start_period: "60s",
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should warn when interval < timeout", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "5s",
                timeout: "30s",
                retries: 3,
                start_period: "10s",
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("interval (5s) is shorter than timeout (30s)"),
      );
    });

    it("should warn when retries is 1", () => {
      validateHealthChecks(
        {
          services: {
            api: {
              image: "node",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "30s",
                timeout: "10s",
                retries: 1,
                start_period: "60s",
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('service "api" has only 1 retry'),
      );
    });

    it("should warn when no start_period with short interval", () => {
      validateHealthChecks(
        {
          services: {
            api: {
              image: "node",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "5s",
                timeout: "3s",
                retries: 3,
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "no start period with a short health check interval (5s)",
        ),
      );
    });

    it("should not warn when start_period is set with short interval", () => {
      validateHealthChecks(
        {
          services: {
            api: {
              image: "node",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "5s",
                timeout: "3s",
                retries: 3,
                start_period: "30s",
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should skip all warnings when healthCheckWarnings is false", () => {
      validateHealthChecks(
        {
          services: {
            web: { image: "nginx" },
            api: {
              image: "node",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "1s",
                timeout: "30s",
                retries: 1,
              },
            },
          },
        },
        { healthCheckWarnings: false },
      );

      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should not warn for interval >= 10s without start_period", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "10s",
                timeout: "5s",
                retries: 3,
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should handle complex duration formats", () => {
      validateHealthChecks(
        {
          services: {
            web: {
              image: "nginx",
              healthcheck: {
                test: "CMD curl -f http://localhost/",
                interval: "1m30s",
                timeout: "2m",
                retries: 3,
                start_period: "30s",
              },
            },
          },
        },
        { healthCheckWarnings: true },
      );

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "interval (1m30s) is shorter than timeout (2m)",
        ),
      );
    });
  });

  describe("formatHealthCheck", () => {
    it("should format health check with all fields", () => {
      const result = formatHealthCheck({
        test: ["CMD-SHELL", "curl -f http://localhost/health"],
        interval: "30s",
        timeout: "10s",
        retries: 3,
        start_period: "60s",
      });

      expect(result).toContain("CMD-SHELL curl -f http://localhost/health");
      expect(result).toContain("Interval:     30s");
      expect(result).toContain("Timeout:      10s");
      expect(result).toContain("Retries:      3");
      expect(result).toContain("Start period: 60s");
    });

    it("should format health check with string test", () => {
      const result = formatHealthCheck({
        test: "curl -f http://localhost/health",
      });

      expect(result).toContain("Test:         curl -f http://localhost/health");
      expect(result).toContain("Interval:     default");
      expect(result).toContain("Timeout:      default");
      expect(result).toContain("Retries:      default");
      expect(result).toContain("Start period: default");
    });

    it("should show 'not specified' when test is missing", () => {
      const result = formatHealthCheck({});

      expect(result).toContain("Test:         not specified");
    });
  });

  describe("findServiceHealthCheck", () => {
    const spec = {
      services: {
        web: {
          image: "nginx",
          healthcheck: {
            test: ["CMD", "curl", "-f", "http://localhost/"],
            interval: "30s",
            timeout: "10s",
            retries: 3,
          },
        },
        worker: {
          image: "node",
        },
        disabled: {
          image: "redis",
          healthcheck: { test: "NONE" },
        },
      },
    };

    it("should find health check by exact service name", () => {
      const hc = findServiceHealthCheck(spec, "web");
      expect(hc).toBeDefined();
      expect(hc?.interval).toBe("30s");
    });

    it("should find health check by stack-prefixed name", () => {
      const hc = findServiceHealthCheck(spec, "mystack_web");
      expect(hc).toBeDefined();
      expect(hc?.interval).toBe("30s");
    });

    it("should return undefined for service without health check", () => {
      const hc = findServiceHealthCheck(spec, "worker");
      expect(hc).toBeUndefined();
    });

    it("should return undefined for disabled health check", () => {
      const hc = findServiceHealthCheck(spec, "disabled");
      expect(hc).toBeUndefined();
    });

    it("should return undefined for unknown service", () => {
      const hc = findServiceHealthCheck(spec, "nonexistent");
      expect(hc).toBeUndefined();
    });
  });
});
