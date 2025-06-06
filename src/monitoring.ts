import * as core from "@actions/core";
import {
  getServiceLogs,
  listServices,
  type Service,
  type ServiceWithMetadata,
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
    core.info("Post-Deployment monitoring is disabled");

    return;
  }

  core.startGroup("Monitoring deployment rollout");
  core.info(`Monitoring stack "${settings.stack}" for post-deployment issues`);

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

    services = await listServices(
      { labels: { "com.docker.stack.namespace": settings.stack } },
      true,
    );

    core.debug(
      `Waiting for services to complete: ` +
        `${completedServices.size}/${services.length}`,
    );

    for (const service of services) {
      if (completedServices.has(service.ID)) {
        continue;
      }

      let complete;

      try {
        complete = isServiceUpdateComplete(service);
      } catch (error) {
        if (!(error instanceof Error)) {
          core.error(
            "An unexpected error occurred while checking the service" +
              "status. This is likely a bug in the deployment action. Please " +
              "report this issue in the repository.",
          );

          throw error;
        }

        const logs = await getServiceLogs(service.ID, { since: startTime });

        core.error(
          `Service "${service.Spec.Name ?? service.ID}" failed to update: ` +
            error.message,
        );
        core.setOutput("service-logs", logs.toString());
        core.summary.addHeading("Service Logs", 2);
        core.summary.addRaw(
          "Before the service update failed, the following logs were generated:",
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
            { data: entry.timestamp.toISOString() },
            { data: entry.message },
            ...(entry.metadata
              ? Object.values(entry.metadata).map((value) => ({ data: value }))
              : []),
          ]),
        ]);

        throw error;
      }

      if (complete) {
        core.info(
          `Service "${service.Spec?.Name ?? service.Name}" has been deployed successfully`,
        );
        completedServices.add(service.ID);
      }
    }

    // In case all services have been updated during the first iteration, we
    // don't want to sleep and drag out the deployment process unnecessarily.
    if (completedServices.size < services.length) {
      await sleep(settings.monitorInterval * 1_000);
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
function isServiceUpdateComplete(service: ServiceWithMetadata) {
  const name = service.Spec?.Name ?? service.Name;
  core.debug(`Checking update status of service ${name}`);

  if (isServiceRunning(service)) {
    return true;
  }

  const updateStatus = service.UpdateStatus?.State ?? "unknown";

  if (updateStatus === "completed") {
    core.debug(`Update of service "${name}" is complete`);

    return true;
  }

  if (updateStatus === "updating") {
    core.debug(`Update of service "${name}" is still in progress`);

    return false;
  }

  const reason = resolveFailureReason(updateStatus);

  throw new Error(`Update of service "${name}" failed: ${reason}`);
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
function isServiceRunning(service: ServiceWithMetadata) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking if service "${name}" is currently running`);

  if (service.Replicas) {
    const [running = 0, desired = 0] = service.Replicas.split("/", 2);

    if (running === desired) {
      core.debug(`Service "${name}" is running`);

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
 * @returns A human-readable string describing the failure reason
 */
function resolveFailureReason(
  state:
    | Exclude<Service["UpdateStatus"]["State"], "completed" | "updating">
    | "unknown",
) {
  return (
    {
      paused: "Service is paused",
      rollback_started: "Service failed to update and is being rolled back",
      rollback_completed: "Service failed to update and was rolled back",
      rollback_paused: "Service is paused and is being rolled back",
      unknown: "Service update status is unknown",
    }[state] ?? "Unknown failure reason"
  );
}
