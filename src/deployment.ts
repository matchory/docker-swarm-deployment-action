import {
  loadComposeSpecs,
  normalizeSpec,
  resolveComposeFiles,
} from "./compose.js";
import { deployStack } from "./engine.js";
import { monitorDeployment } from "./monitoring.js";
import type { Settings } from "./settings.js";
import { pruneVariables } from "./variables.js";

/**
 * Main deployment function
 */
export async function deploy(settings: Readonly<Settings>) {
  const composeFiles = await resolveComposeFiles(settings);
  const composeSpecs = await loadComposeSpecs(composeFiles, settings);
  const composeSpec = await normalizeSpec(composeSpecs, settings);

  await deployStack(composeSpec, settings);

  if (settings.monitor) {
    await monitorDeployment(settings);
  }

  await pruneVariables(composeSpec, settings);

  return composeSpec;
}
