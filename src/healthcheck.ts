import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import type { Settings } from "./settings.js";

export interface HealthCheck {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
  disable?: boolean;
}

/**
 * Validate health check configurations for all services in the compose spec.
 * Emits warnings for missing or suspect health checks.
 */
export function validateHealthChecks(
  spec: ComposeSpec,
  settings: Pick<Readonly<Settings>, "healthCheckWarnings">,
) {
  if (!settings.healthCheckWarnings) {
    return;
  }

  for (const [name, service] of Object.entries(spec.services)) {
    const healthcheck = (service as { healthcheck?: HealthCheck }).healthcheck;

    if (!healthcheck || isHealthCheckDisabled(healthcheck)) {
      core.warning(`Service "${name}" has no health check defined`);
      continue;
    }

    validateHealthCheckConfig(name, healthcheck);
  }
}

function isHealthCheckDisabled(healthcheck: HealthCheck | undefined): boolean {
  if (!healthcheck) {
    return true;
  }

  if (healthcheck.disable === true) {
    return true;
  }

  const test = healthcheck.test;

  if (test === "NONE") {
    return true;
  }

  if (Array.isArray(test) && test.length === 1 && test[0] === "NONE") {
    return true;
  }

  return false;
}

function validateHealthCheckConfig(name: string, healthcheck: HealthCheck) {
  const interval = parseDuration(healthcheck.interval);
  const timeout = parseDuration(healthcheck.timeout);
  const startPeriod = parseDuration(healthcheck.start_period);

  if (interval !== null && timeout !== null && interval < timeout) {
    core.warning(
      `Health check interval (${healthcheck.interval}) is shorter than ` +
        `timeout (${healthcheck.timeout}) for service "${name}"`,
    );
  }

  if (healthcheck.retries === 1) {
    core.warning(
      `Health check for service "${name}" has only 1 retry; a single ` +
        `failure will mark the container unhealthy`,
    );
  }

  if (
    interval !== null &&
    interval < 10_000_000_000 &&
    (startPeriod === null || startPeriod === 0)
  ) {
    core.warning(
      `Service "${name}" has no start period with a short health check ` +
        `interval (${healthcheck.interval}); container may fail checks ` +
        `before it is ready`,
    );
  }
}

/**
 * Format a health check configuration for display in failure reports.
 */
export function formatHealthCheck(healthcheck: HealthCheck): string {
  const test = Array.isArray(healthcheck.test)
    ? healthcheck.test.join(" ")
    : (healthcheck.test ?? "not specified");

  const lines = [
    `  Test:         ${test}`,
    `  Interval:     ${healthcheck.interval ?? "default"}`,
    `  Timeout:      ${healthcheck.timeout ?? "default"}`,
    `  Retries:      ${healthcheck.retries ?? "default"}`,
    `  Start period: ${healthcheck.start_period ?? "default"}`,
  ];

  return lines.join("\n");
}

/**
 * Look up the health check config for a service by name from the compose spec.
 */
export function findServiceHealthCheck(
  spec: ComposeSpec | undefined,
  serviceName: string,
): HealthCheck | undefined {
  if (!spec) {
    return undefined;
  }

  // Service names in the spec are the short names (without stack prefix).
  // The serviceName from monitoring may be stack-prefixed (e.g., "mystack_api").
  for (const [name, service] of Object.entries(spec.services)) {
    if (name === serviceName || serviceName.endsWith(`_${name}`)) {
      const hc = (service as { healthcheck?: HealthCheck }).healthcheck;

      if (hc && !isHealthCheckDisabled(hc)) {
        return hc;
      }

      return undefined;
    }
  }

  return undefined;
}

/**
 * Parse a Docker duration string (e.g., "30s", "1m30s", "100ms") to
 * nanoseconds, matching Docker's Go `time.Duration` parsing.
 * Returns null if the string is undefined or unparseable.
 */
function parseDuration(duration: string | undefined): number | null {
  if (!duration) {
    return null;
  }

  let remaining = duration.trim();
  let total = 0;

  const units: Record<string, number> = {
    ns: 1,
    us: 1_000,
    ms: 1_000_000,
    s: 1_000_000_000,
    m: 60_000_000_000,
    h: 3_600_000_000_000,
  };

  while (remaining.length > 0) {
    const match = remaining.match(/^(\d+(?:\.\d+)?)(ns|us|ms|[smh])/);

    if (!match) {
      return null;
    }

    const value = Number.parseFloat(match[1]);
    const unit = match[2];
    total += value * units[unit];
    remaining = remaining.slice(match[0].length);
  }

  return total;
}
