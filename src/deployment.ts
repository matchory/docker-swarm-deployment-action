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
import { assertOwnShares } from "./shares.js";
import { warnAboutUndefinedVariables } from "./utils.js";
import { pruneVariables, removeGeneratedVariableFiles } from "./variables.js";

/**
 * Main deployment function
 */
export async function deploy(settings: Readonly<Settings>) {
  let finalSpec: ComposeSpec;

  // Shared, so a variable used in both passes is only reported once
  const onUndefined = warnAboutUndefinedVariables();

  try {
    const composeFiles = await resolveComposeFiles(settings);
    const composeSpecs = (
      await loadComposeSpecs(composeFiles, settings, onUndefined)
    ).map((item) => ({
      ...item,
      spec: interpolateTypedFields(item.spec, settings, onUndefined),
    }));
    const composeSpec = await normalizeSpec(composeSpecs, settings);
    finalSpec = interpolateSpec(composeSpec, settings, onUndefined);

    // After interpolation: volume names are often built from variables.
    assertOwnShares(finalSpec, settings.stack);
    validateHealthChecks(finalSpec, settings);

    await deployStack(finalSpec, settings);
  } finally {
    await removeGeneratedVariableFiles();
  }

  if (settings.monitor) {
    await monitorDeployment(settings, finalSpec);
  }

  // Without variable management, the spec carries no deployment labels, so
  // pruning would treat every variable of the stack as outdated.
  if (settings.manageVariables) {
    await pruneVariables(finalSpec, settings);
  }

  return finalSpec;
}
