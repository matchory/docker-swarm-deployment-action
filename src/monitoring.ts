import * as core from "@actions/core";
import {
  getServiceLogs,
  listServices,
  listServiceTasks,
  type Service,
  type ServiceWithMetadata,
} from "./engine.js";
import type { Settings } from "./settings.js";
import type { TaskInfo } from "./types.js";
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
  let services: ServiceWithMetadata[];

  do {
    if (--attemptsLeft <= 0) {
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
        const message = error instanceof Error ? error.message : String(error);

        // Fetch task details to get actionable error information
        let taskFailureDetails: string | undefined;
        try {
          const tasks = await listServiceTasks(service.ID);
          taskFailureDetails = await getTaskFailureDetails(tasks);
        } catch (taskError) {
          core.debug(
            `Failed to fetch task details: ${taskError instanceof Error ? taskError.message : String(taskError)}`,
          );
        }

        // Build comprehensive error message with task details
        const errorMessage = taskFailureDetails
          ? `Service "${serviceIdentifier}" failed to update: ${message}. ${taskFailureDetails}`
          : `Service "${serviceIdentifier}" failed to update: ${message}`;

        // Single error annotation with actionable information
        core.error(new Error(errorMessage, { cause: error }));

        // Fetch logs for summary
        const logs = await getServiceLogs(service.ID, { since: startTime });
        core.setOutput("service-logs", logs.toString());

        // Add detailed information to job summary (not as error annotation)
        core.summary.addHeading("Service Update Failure Details", 2);
        core.summary.addRaw(
          `Service "${serviceIdentifier}" failed to update.`,
          true,
        );

        // Add task failure details to summary if available
        if (taskFailureDetails) {
          core.summary.addHeading("Task Failure Reason", 3);
          core.summary.addRaw(taskFailureDetails, true);
        }

        // Add service logs to summary
        core.summary.addHeading("Service Logs", 3);
        core.summary.addRaw(
          `Logs generated before the service update failed:`,
          true,
        );
        core.summary.addTable([
          [
            { data: "timestamp", header: true },
            { data: "message", header: true },
            ...(logs[0]
              ? Object.keys(logs[0].metadata).map((key) => ({
                  data: key,
                  header: true,
                }))
              : []),
          ],
          ...logs.map((entry) => [
            { data: entry.timestamp?.toISOString() ?? "<no timestamp>" },
            { data: entry.message },
            ...(entry.metadata
              ? Object.values(entry.metadata).map((value) => ({ data: value }))
              : []),
          ]),
        ]);

        // Add service details to summary for debugging
        core.summary.addHeading("Service Details (Debug)", 3);
        core.summary.addCodeBlock(JSON.stringify(service, null, 2), "json");

        throw error;
      }

      if (complete) {
        core.info(
          `Service "${serviceIdentifier}" has been deployed successfully`,
        );
        completedServices.add(service.ID);
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
      paused:
        "Service update paused due to task failure (check task logs for details)",
      rollback_started: "Service failed to update and is being rolled back",
      rollback_completed: "Service failed to update and was rolled back",
      rollback_paused:
        "Service rollback paused due to task failure (check task logs for details)",
      unknown: `Service update status '${state}' is unknown`,
    }[state] ?? "Unknown failure reason";

  return reason + (message ? `: ${message}` : "");
}

/**
 * Extract actionable error information from failed tasks
 *
 * This function analyzes failed tasks to provide meaningful error messages
 * that help diagnose why a service update failed. It examines task states,
 * error messages, and failure patterns to give actionable feedback.
 *
 * @param tasks Array of tasks from docker service ps
 * @returns A string describing the task failure reason, or undefined if no clear failure
 */
async function getTaskFailureDetails(
  tasks: TaskInfo[],
): Promise<string | undefined> {
  // Filter to only failed or rejected tasks
  const failedTasks = tasks.filter(
    (task) =>
      task.Status.State === "failed" ||
      task.Status.State === "rejected" ||
      task.DesiredState === "shutdown",
  );

  if (failedTasks.length === 0) {
    return undefined;
  }

  // Get the most recent failed task
  const recentFailedTask = failedTasks.sort(
    (a, b) =>
      new Date(b.UpdatedAt).getTime() - new Date(a.UpdatedAt).getTime(),
  )[0];

  // Extract error information
  const errorParts: string[] = [];

  if (recentFailedTask.Status.Err) {
    errorParts.push(recentFailedTask.Status.Err);
  } else if (recentFailedTask.Status.Message) {
    errorParts.push(recentFailedTask.Status.Message);
  }

  // Add context about the task state
  if (recentFailedTask.Status.State === "rejected") {
    errorParts.push("task was rejected by the scheduler");
  } else if (recentFailedTask.Status.State === "failed") {
    errorParts.push("task failed to start or run successfully");
  }

  return errorParts.length > 0
    ? `Task ${recentFailedTask.ID.substring(0, 12)} ${errorParts.join(": ")}`
    : undefined;
}
