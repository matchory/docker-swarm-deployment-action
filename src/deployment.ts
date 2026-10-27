import {
  type ComposeSpec,
  interpolateSpec,
  interpolateTypedFields,
  loadComposeSpecs,
  normalizeSpec,
  readStackSettings,
  resolveComposeFiles,
} from "./compose.js";
import { deployStack } from "./engine.js";
import { validateHealthChecks } from "./healthcheck.js";
import {
  addDeploymentLabels,
  resolveServiceOptions,
  type ServiceOptions,
} from "./labels.js";
import { monitorDeployment } from "./monitoring.js";
import { applyStackSettings, type Settings } from "./settings.js";
import { assertOwnShares } from "./shares.js";
import { warnAboutUndefinedVariables } from "./utils.js";
import { pruneVariables, removeGeneratedVariableFiles } from "./variables.js";

/**
 * Main deployment function
 */
export async function deploy(inputSettings: Readonly<Settings>) {
  const composeFiles = await resolveComposeFiles(inputSettings);
  const settings = applyStackSettings(
    inputSettings,
    await readStackSettings(composeFiles),
  );
  let finalSpec: ComposeSpec;
  let serviceOptions: Map<string, ServiceOptions>;

  // Shared, so a variable used in both passes is only reported once
  const onUndefined = warnAboutUndefinedVariables();

  try {
    const composeSpecs = (
      await loadComposeSpecs(composeFiles, settings, onUndefined)
    ).map((item) => ({
      ...item,
      spec: interpolateTypedFields(item.spec, settings, onUndefined),
    }));
    const composeSpec = await normalizeSpec(
      composeSpecs,
      settings,
      onUndefined,
    );
    finalSpec = interpolateSpec(composeSpec, settings, onUndefined);

    // After interpolation: volume names are often built from variables, and
    // service labels may be too.
    assertOwnShares(finalSpec, settings.stack);
    serviceOptions = resolveServiceOptions(finalSpec, settings);
    validateHealthChecks(finalSpec, settings, serviceOptions);

    finalSpec = addDeploymentLabels(finalSpec, settings.deploymentLabels ?? {});

    await deployStack(finalSpec, settings);
  } finally {
    await removeGeneratedVariableFiles();
  }

  if ([...serviceOptions.values()].some(({ monitor }) => monitor)) {
    await monitorDeployment(settings, finalSpec, serviceOptions);
  }

  // Without variable management, the spec carries no deployment labels, so
  // pruning would treat every variable of the stack as outdated.
  if (settings.manageVariables) {
    await pruneVariables(finalSpec, settings);
  }

  return finalSpec;
}
