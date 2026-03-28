import * as core from "@actions/core";
import {
  getServiceLogs,
  listServices,
  listServiceTasks,
  type Service,
  type ServiceWithMetadata,
  type TaskStatus,
} from "./engine.js";
import type { Settings } from "./settings.js";
import { sleep } from "./utils.js";

/**
 * Monitor deployment rollout
 *
 * This function monitors the deployment of a Docker stack and checks the status
 * of its tasks until all tasks are running or a timeout occurs.
 * It provides feedback on the deployment status and attempts to report any
 * errors encountered after the containers are started.
 *
 * @param settings Deployment settings
 */
export async function monitorDeployment(settings: Readonly<Settings>) {
  if (!settings.monitor) {
    core.info("Post-Deployment Monitoring is disabled");

    return;
  }

  core.info(`Monitoring Stack "${settings.stack}" for Post-Deployment Issues`);

  const startTime = new Date();
  let attemptsLeft = Math.ceil(
    settings.monitorTimeout / settings.monitorInterval,
  );
  const completedServices = new Set<string>();
  let services: ServiceWithMetadata[] = [];

  do {
    if (--attemptsLeft <= 0) {
      // On timeout, report diagnostics for all non-converged services
      for (const service of services) {
        if (completedServices.has(service.ID)) {
          continue;
        }
        const name = service.Spec?.Name ?? service.Name ?? service.ID;
        await buildFailureReport(service.ID, name, startTime);
      }

      throw new Error("Deployment timed out");
    }

    await sleep(settings.monitorInterval * 1_000);

    services = await listServices(
      { labels: { "com.docker.stack.namespace": settings.stack } },
      true,
    );

    core.debug(
      `Waiting for services to finish updating: ` +
        `${completedServices.size}/${services.length}`,
    );

    for (const service of services) {
      if (completedServices.has(service.ID)) {
        continue;
      }

      const serviceIdentifier =
        service.Spec?.Name ?? service.Name ?? service.ID;
      let complete: boolean;

      try {
        complete = isServiceUpdateComplete(service);
      } catch (error) {
        await buildFailureReport(service.ID, serviceIdentifier, startTime);
        core.error(`Service Details:\n${JSON.stringify(service, null, 2)}`);

        throw error;
      }

      if (complete) {
        core.info(
          `Service "${serviceIdentifier}" has been deployed successfully`,
        );
        completedServices.add(service.ID);
        continue;
      }

      // If the service appears to be "updating" but all tasks are in a
      // terminal failure state, it will never recover — fail early instead
      // of waiting for the full timeout.
      const tasks = await fetchTasks(service.ID);
      if (tasks && isServiceStuck(tasks)) {
        await buildFailureReport(
          service.ID,
          serviceIdentifier,
          startTime,
          tasks,
        );
        throw new Error(
          `Service "${serviceIdentifier}" failed: all tasks are in a failed state`,
        );
      }
    }
  } while (completedServices.size < services.length);

  core.info("All services have been deployed successfully");
}

/**
 * Check if a Docker service is complete.
 *
 * This function checks whether a Docker service is complete by examining its
 * update status and compares the number of running and desired tasks.
 *
 * @param service Service to check
 * @returns True if the service is complete, false otherwise
 */
export function isServiceUpdateComplete(
  service: Pick<
    ServiceWithMetadata,
    "Spec" | "Name" | "ID" | "UpdateStatus" | "Replicas"
  >,
) {
  const name = service.Spec?.Name ?? service.Name;
  core.debug(`Checking update status of service ${name}`);

  // Handle missing UpdateStatus
  if (!service.UpdateStatus) {
    if (isServiceRunning(service)) {
      core.info(
        `Service "${name}" is still running and did not require an update`,
      );
      return true;
    } else {
      core.info(`Service "${name}" is still updating`);
      return false;
    }
  }

  // If UpdateStatus exists but State is missing, treat it as "updating"
  // This handles race conditions where service hasn't fully started yet
  const updateStatus = service.UpdateStatus?.State ?? "updating";

  if (updateStatus === "completed") {
    core.info(`Update of service "${name}" is complete`);

    return true;
  }

  if (updateStatus === "updating") {
    core.info(`Update of service "${name}" is still in progress`);

    return false;
  }

  const reason = resolveFailureReason(
    updateStatus,
    service.UpdateStatus?.Message,
  );

  throw new Error(`Update of service "${name}" failed: ${reason}`, {
    cause: service.UpdateStatus,
  });
}

/**
 * Check if a Swarm Service is running.
 *
 * The Docker API exposes the number of running and desired tasks for a running
 * service. If these numbers are equal, the service has converged and is running
 * as expected; for our case, this means that the service has either been
 * updated or no update was required.
 *
 * @param service Service to check
 * @returns True if the service is running, false otherwise
 */
export function isServiceRunning(
  service: Pick<ServiceWithMetadata, "Spec" | "Replicas" | "ID">,
) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking if service "${name}" is currently running`);

  if (service.Replicas) {
    const [running = 0, desired = 0] = service.Replicas.split("/", 2);

    if (running === desired) {
      core.debug(
        `Service "${name}" is running (${running}/${desired} replicas)`,
      );

      return true;
    }

    core.debug(
      `Service "${name}" is only partially running: ` +
        `${running}/${desired} tasks running`,
    );

    return false;
  }

  core.debug(`Service "${name}" is not running`);

  return false;
}

async function fetchTasks(serviceId: string): Promise<TaskStatus[] | null> {
  try {
    return await listServiceTasks(serviceId);
  } catch {
    return null;
  }
}

/**
 * Check if all tasks are in terminal failure states.
 *
 * When a service has tasks but every task has failed or been rejected
 * (and none are running, pending, or being prepared), the service will
 * never recover on its own.
 */
export function isServiceStuck(tasks: TaskStatus[]): boolean {
  if (tasks.length === 0) {
    return false;
  }

  return tasks.every(
    (t) =>
      t.CurrentState.startsWith("Failed") ||
      t.CurrentState.startsWith("Rejected"),
  );
}

/**
 * Resolve the failure reason for a service update
 *
 * The failure reason is determined by the state of the service update.
 * The state can be one of the following:
 * - "paused"
 * - "rollback_started"
 * - "rollback_completed"
 * - "rollback_paused"
 * - "unknown"
 *
 * The function returns a human-readable string describing the failure reason.
 *
 * @param state The state of the service update
 * @param message Optional message providing additional context
 * @returns A human-readable string describing the failure reason
 */
function resolveFailureReason(
  state:
    | Exclude<
        Exclude<Service["UpdateStatus"], undefined>["State"],
        "completed" | "updating"
      >
    | "unknown",
  message?: string,
) {
  const reason =
    {
      paused: "Service is paused",
      rollback_started: "Service failed to update and is being rolled back",
      rollback_completed: "Service failed to update and was rolled back",
      rollback_paused: "Service is paused and is being rolled back",
      unknown: `Service update status '${state}' is unknown`,
    }[state] ?? "Unknown failure reason";

  return reason + (message ? `: ${message}` : "");
}

/**
 * Build a structured diagnostic report for a failed service update.
 */
export async function buildFailureReport(
  serviceId: string,
  serviceName: string,
  startTime: Date,
  prefetchedTasks?: TaskStatus[],
) {
  const tasks = prefetchedTasks ?? (await fetchTasks(serviceId));

  if (!tasks) {
    core.error(`Failed to fetch task details for service "${serviceName}"`);
    return;
  }

  if (tasks.length === 0) {
    core.error(`No task information available for service "${serviceName}"`);
    return;
  }

  const failedTasks = tasks.filter(
    (t) => t.Error && t.DesiredState !== "Running",
  );
  const latestFailedTask = failedTasks[0];
  const headline = latestFailedTask
    ? categorizeTaskError(latestFailedTask.Error).headline
    : undefined;

  if (headline) {
    core.error(`Service "${serviceName}" failed to deploy: ${headline}`);
  } else {
    core.error(
      `Service "${serviceName}" failed to deploy (no task error details available)`,
    );
  }

  const history = tasks
    .map((t) => {
      const error = t.Error ? ` "${t.Error}"` : "";
      return `  ${t.Name}  ${t.DesiredState.padEnd(10)}  ${t.CurrentState}${error}  (node: ${t.Node})`;
    })
    .join("\n");

  core.error(`Task history for service "${serviceName}":\n${history}`);

  let logs: Awaited<ReturnType<typeof getServiceLogs>>;

  try {
    logs = await getServiceLogs(serviceId, { since: startTime, tail: 50 });
  } catch {
    core.warning(`Failed to fetch container logs for service "${serviceName}"`);
    logs = [];
  }

  const formattedLogs = logs.map((entry) => {
    const ts = entry.timestamp?.toISOString() ?? "<no timestamp>";
    return `${ts}  ${entry.message}`;
  });

  if (formattedLogs.length === 0) {
    core.error(
      `No container logs available for service "${serviceName}" (container may not have started)`,
    );
  } else {
    core.error(
      `Container logs for service "${serviceName}":\n${formattedLogs.map((l) => `  ${l}`).join("\n")}`,
    );
  }

  // Job summary
  core.summary.addHeading(`Deployment failure: ${serviceName}`, 2);

  if (headline) {
    core.summary.addRaw(`**Root cause:** ${headline}`, true);
  }

  core.summary.addHeading("Task history", 3);
  core.summary.addTable([
    [
      { data: "Task", header: true },
      { data: "State", header: true },
      { data: "Current State", header: true },
      { data: "Error", header: true },
      { data: "Node", header: true },
    ],
    ...tasks.map((t) => [
      { data: t.Name },
      { data: t.DesiredState },
      { data: t.CurrentState },
      { data: t.Error || "-" },
      { data: t.Node },
    ]),
  ]);

  if (formattedLogs.length > 0) {
    core.summary.addHeading("Container logs", 3);
    core.summary.addCodeBlock(formattedLogs.join("\n"));
  } else {
    core.summary.addRaw(
      "_No container logs available (container may not have started)_",
      true,
    );
  }
}

export type ErrorCategory =
  | "image_pull"
  | "oom_kill"
  | "container_crash"
  | "health_check"
  | "scheduling"
  | "startup_failure"
  | "network"
  | "volume"
  | "config"
  | "dependency"
  | "entrypoint"
  | "port_conflict"
  | "unknown";

const errorPatterns: Array<{
  test: (e: string) => boolean;
  category: ErrorCategory;
  headline: (e: string) => string;
}> = [
  {
    test: (e) =>
      /No such image|manifest unknown|manifest not found|pull access denied|unauthorized/.test(
        e,
      ),
    category: "image_pull",
    headline: (e) => `Image could not be pulled: ${e}`,
  },
  {
    test: (e) => /non-zero exit \(137\)/.test(e),
    category: "oom_kill",
    headline: () => "Container killed (likely OOM): exit code 137",
  },
  {
    test: (e) => /non-zero exit \((\d+)\)/.test(e),
    category: "container_crash",
    headline: (e) => {
      const code = e.match(/non-zero exit \((\d+)\)/)?.[1] ?? "?";
      return `Container exited with code ${code}`;
    },
  },
  {
    test: (e) => /unhealthy container/.test(e),
    category: "health_check",
    headline: () => "Container failed health check",
  },
  {
    test: (e) => /no suitable node/.test(e),
    category: "scheduling",
    headline: (e) => `No node available to run this task: ${e}`,
  },
  {
    test: (e) =>
      /starting container failed|OCI runtime create failed/.test(e) &&
      !/exec format error|permission denied|no such file or directory/.test(e),
    category: "startup_failure",
    headline: (e) => `Container failed to start: ${e}`,
  },
  {
    test: (e) =>
      /exec format error|(?:^|\W)permission denied|no such file or directory/.test(
        e,
      ),
    category: "entrypoint",
    headline: (e) => `Container entrypoint failed: ${e}`,
  },
  {
    test: (e) =>
      /failed to allocate network IP|Address already in use|missing network attachments/.test(
        e,
      ),
    category: "network",
    headline: (e) => `Network allocation failed: ${e}`,
  },
  {
    test: (e) => /invalid bind mount source|no space left on device/.test(e),
    category: "volume",
    headline: (e) => `Volume or mount failed: ${e}`,
  },
  {
    test: (e) =>
      /secret reference|config reference|(?:secret|config)\S*\s+not found/.test(
        e,
      ),
    category: "config",
    headline: (e) => `Secret or config reference invalid: ${e}`,
  },
  {
    test: (e) => /dependency not ready/.test(e),
    category: "dependency",
    headline: () => "Task dependencies not yet available",
  },
  {
    test: (e) => /host-mode port already in use/.test(e),
    category: "port_conflict",
    headline: (e) => `Host port already in use: ${e}`,
  },
];

export function categorizeTaskError(error: string): {
  category: ErrorCategory;
  headline: string;
} {
  if (!error) {
    return { category: "unknown", headline: "Unknown error" };
  }

  for (const pattern of errorPatterns) {
    if (pattern.test(error)) {
      return {
        category: pattern.category,
        headline: pattern.headline(error),
      };
    }
  }

  return { category: "unknown", headline: error };
}
