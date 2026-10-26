import { writeFile } from "node:fs/promises";
import { env } from "node:process";
import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import type { ComposeSpec } from "./compose";
import { deploy } from "./deployment.js";
import { parseSettings, type Settings } from "./settings.js";
import { removeFileQuietly } from "./utils.js";
import { redactSecretValues } from "./variables.js";

export async function run() {
  let settings: Settings | undefined;
  let composeSpec: ComposeSpec | undefined;

  // Parsing happens inside the try: bad input is an ordinary failure, and a
  // throw escaping `run()` would reach the runner as an uncaught exception,
  // which prints the whole generated bundle line above the stack trace.
  try {
    settings = parseSettings(env);
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

  if (!composeSpec || !settings) {
    return;
  }

  if (!settings.uploadComposeSpec) {
    core.info("Compose spec artifact upload is disabled");

    return;
  }

  try {
    await storeComposeSpecArtifact(composeSpec, settings.secretValues);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    core.warning(
      new Error(`Failed to store compose spec artifact: ${message}`, {
        cause,
      }),
    );
  }
}

async function storeComposeSpecArtifact(
  spec: ComposeSpec,
  secretValues: ReadonlyMap<string, string>,
) {
  const artifactClient = new DefaultArtifactClient();
  const path = `./compose-spec.generated.${crypto.randomUUID()}.json`;

  // Redacted here, not at the call site, so the artifact cannot be written
  // unredacted. See `redactSecretValues` for what is left intact, and why.
  const redacted = redactSecretValues(spec, secretValues);

  try {
    try {
      await writeFile(path, JSON.stringify(redacted, null, 2));
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
  } finally {
    await removeFileQuietly(path, "temporary compose spec file");
  }
}
