import Dockerode from "dockerode";
import packageJson from "../package.json" with { type: "json" };
import {
  deployStack,
  loadComposeSpecs,
  normalizeComposeSpec,
  resolveComposeFiles,
} from "./compose.js";
import { monitorDeployment } from "./monitoring.js";
import type { Settings } from "./settings.js";
import { pruneVariables } from "./variables.js";

export function createClient(_settings: Readonly<Settings>) {
  const { version } = packageJson;

  return new Dockerode({
    headers: {
      "user-agent": `matchory-deployment/${version} (github-action)`,
    },
  });
}

/**
 * Main deployment function
 */
export async function deploy(settings: Readonly<Settings>) {
  const client = createClient(settings);
  const composeFiles = await resolveComposeFiles(settings);
  const composeSpecs = await loadComposeSpecs(composeFiles, settings);
  const composeSpec = await normalizeComposeSpec(composeSpecs, settings);

  await deployStack(composeSpec, settings);

  if (settings.monitor) {
    await monitorDeployment(client, settings);
  }

  await pruneVariables(composeSpec, client, settings);

  return composeSpec;
}
