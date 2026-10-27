import * as core from "@actions/core";
import {
  listConfigs,
  listSecrets,
  listServices,
  removeStack,
} from "./engine.js";
import type { Settings } from "./settings.js";
import { stackLabel, versionLabel } from "./variables.js";

/**
 * Remove the stack instead of deploying it
 *
 * Only removes a stack this action deployed: one of its services carries the
 * deployment labels, or one of its configs or secrets is managed by the action
 * for this stack. The latter recognizes stacks deployed by earlier versions,
 * which did not label services yet. Without either, a mistyped stack name
 * could remove an unrelated stack.
 *
 * @param settings Deployment settings
 */
export async function destroy({ stack }: Pick<Readonly<Settings>, "stack">) {
  const namespace = { "com.docker.stack.namespace": stack };
  const [services, configs, secrets] = await Promise.all([
    listServices({ labels: namespace }, true),
    listConfigs({ labels: namespace }),
    listSecrets({ labels: namespace }),
  ]);
  const owned =
    services.some((service) => versionLabel in (service.Spec?.Labels ?? {})) ||
    [...configs, ...secrets].some(
      (variable) => variable.Labels[stackLabel] === stack,
    );

  // Without services, configs or secrets there is nothing to verify, but
  // removing the stack still cleans up networks a failed removal left behind.
  if (services.length + configs.length + secrets.length > 0 && !owned) {
    throw new Error(
      `Refusing to remove stack "${stack}": none of its services, configs or ` +
        `secrets carry the labels this action adds, so it was not deployed ` +
        `by this action. Check the "stack-name" input, or remove the stack ` +
        `with "docker stack rm ${stack}" if this is intended.`,
    );
  }

  core.info(`Removing stack "${stack}"`);
  await removeStack(stack);
  core.info(`Removed stack "${stack}"`);
}
