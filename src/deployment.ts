import {
  type ComposeSpec,
  interpolateSpec,
  interpolateTypedFields,
  loadComposeSpecs,
  normalizeSpec,
  resolveComposeFiles,
} from "./compose.js";
import { deployStack } from "./engine.js";
import { validateHealthChecks } from "./healthcheck.js";
import { monitorDeployment } from "./monitoring.js";
import type { Settings } from "./settings.js";
import { pruneVariables, removeGeneratedVariableFiles } from "./variables.js";

/**
 * Main deployment function
 */
export async function deploy(settings: Readonly<Settings>) {
  let finalSpec: ComposeSpec;

  try {
    const composeFiles = await resolveComposeFiles(settings);
    const composeSpecs = (await loadComposeSpecs(composeFiles, settings)).map(
      (item) => ({
        ...item,
        spec: interpolateTypedFields(item.spec, settings),
      }),
    );
    const composeSpec = await normalizeSpec(composeSpecs, settings);
    finalSpec = interpolateSpec(composeSpec, settings);

    validateHealthChecks(finalSpec, settings);

    await deployStack(finalSpec, settings);
  } finally {
    await removeGeneratedVariableFiles();
  }

  if (settings.monitor) {
    await monitorDeployment(settings, finalSpec);
  }

  await pruneVariables(finalSpec, settings);

  return finalSpec;
}
