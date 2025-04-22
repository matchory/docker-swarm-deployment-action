import * as core from "@actions/core";
import Dockerode, { type Service, type UpdateState } from "dockerode";
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
 * @param client Docker client instance
 * @param settings Deployment settings
 */
export async function monitorDeployment(
  client: Readonly<Dockerode>,
  settings: Readonly<Settings>,
) {
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
  let services: Service[];

  do {
    if (--attemptsLeft <= 0) {
      throw new Error("Deployment timed out");
    }

    services = await loadServices(client, settings);

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

        const logs = (await client.getService(service.ID).logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          details: true,
          since: startTime.getTime() / 1_000,
        })) as unknown as Buffer;

        core.error(
          `Service "${service.Spec?.Name ?? service.ID}" failed to ` +
            `update: ${error.message}`,
        );
        core.error(`Service logs since deployment:\n${logs.toString()}`);

        throw error;
      }

      if (complete) {
        core.info(
          `Service "${service.Spec?.Name}" has been deployed successfully`,
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

function loadServices(client: Dockerode, settings: Settings) {
  return client.listServices({
    filters: {
      label: [`com.docker.stack.namespace=${settings.stack}`],
    },
    status: true,
  });
}

/**
 * Check if a Docker service is complete.
 *
 * This function checks whether a Docker service is complete by examining its
 * update status, and compares the number of running and desired tasks.
 *
 * @param service Service to check
 * @returns True if the service is complete, false otherwise
 */
function isServiceUpdateComplete(service: Service) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking update status of service ${name}`);

  if (!service.UpdateStatus) {
    if (isServiceRunning(service)) {
      return true;
    }

    core.debug(`Update of service ${name} is still in progress`);

    return false;
  }

  const updateStatus = service.UpdateStatus.State ?? "unknown";

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
function isServiceRunning(service: Service) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking if service "${name}" is currently running`);

  if (service.ServiceStatus) {
    const running = service.ServiceStatus.RunningTasks ?? 0;
    const desired = service.ServiceStatus.DesiredTasks ?? 0;

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
  state: Exclude<UpdateState, "completed" | "updating"> | "unknown",
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
