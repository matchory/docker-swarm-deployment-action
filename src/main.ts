import { writeFile } from "node:fs/promises";
import { env } from "node:process";
import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import type { ComposeSpec } from "./compose";
import { deploy } from "./deployment.js";
import { parseSettings } from "./settings.js";

export async function run() {
  const settings = parseSettings(env);
  let composeSpec: ComposeSpec | undefined;

  try {
    composeSpec = await deploy(settings);

    core.setOutput("compose-spec", composeSpec);
    core.setOutput("stack-name", settings.stack);
    core.setOutput("version", settings.version);
    core.setOutput("status", "success");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error);
    } else {
      core.setFailed(`An unknown error occurred: ${error}`);
    }

    core.setOutput("status", "failure");
  }

  if (!composeSpec) {
    return;
  }

  try {
    await storeComposeSpecArtifact(composeSpec);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    core.warning(
      new Error(`Failed to store compose spec artifact: ${message}`, {
        cause,
      }),
    );
  }
}

async function storeComposeSpecArtifact(spec: ComposeSpec) {
  const artifactClient = new DefaultArtifactClient();
  const path = `./compose-spec.generated.${crypto.randomUUID()}.json`;

  try {
    await writeFile(path, JSON.stringify(spec, null, 2));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to write compose spec to file: ${message}`, {
      cause,
    });
  }

  try {
    await artifactClient.uploadArtifact("compose-spec", [path], ".", {
      retentionDays: 30,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to upload compose spec artifact: ${message}`, {
      cause,
    });
  }
}
