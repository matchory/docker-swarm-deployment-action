import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    stackList: string;
  }
}

/**
 * Collect the stacks the scenarios deploy, and remove them after the last file
 *
 * Not after each file: deploying right after removing a stack whose services
 * were updated gets the new tasks rejected with "Pool overlaps with other one
 * on this address space" for about 20 seconds. Swarm hands the freed subnet to
 * the new network while the node still holds it.
 */
export default async function setup(project: TestProject) {
  const directory = await mkdtemp(join(tmpdir(), "swarm-test-stacks-"));
  const stackList = join(directory, "stacks");
  await writeFile(stackList, "");
  project.provide("stackList", stackList);

  return async () => {
    const stacks = (await readFile(stackList, "utf8")).split("\n");

    // One stack per call: given several, `docker stack rm --detach=false`
    // has been seen to hang after removing all but the last.
    await Promise.all(
      stacks
        .filter(Boolean)
        .map((name) =>
          promisify(execFile)(
            "docker",
            ["stack", "rm", "--detach=false", name],
            { timeout: 120_000 },
          ),
        ),
    );

    await rm(directory, { recursive: true, force: true });
  };
}
