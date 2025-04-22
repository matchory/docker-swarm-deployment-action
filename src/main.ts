import * as core from "@actions/core";
import { deploy } from "./deployment.js";
import { parseSettings } from "./settings.js";

export async function run() {
  const settings = parseSettings();

  try {
    const composeSpec = await deploy(settings);

    core.setOutput("compose-spec", composeSpec);
    core.setOutput("stack-name", settings.stack);
    core.setOutput("version", settings.version);
    core.setOutput("status", "success");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error);
    } else {
      core.setFailed("An unknown error occurred");
    }

    core.setOutput("status", "failure");
  }
}
