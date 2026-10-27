import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
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
    // A CI runner is discarded after the job, swarm and all
    if (process.env.CI) {
      return;
    }

    const stacks = (await readFile(stackList, "utf8")).split("\n");

    const results = await Promise.allSettled(
      stacks.filter(Boolean).map(removeStack),
    );

    await rm(directory, { recursive: true, force: true });

    // Only cleanup failed, so the scenarios' result stands
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(`Failed to remove a stack: ${result.reason}`);
      }
    }
  };
}

/**
 * Remove a stack, retrying until its networks are gone
 *
 * `docker stack rm` fails to remove a network that a task still being shut
 * down is attached to, and leaves it behind; a later call removes it. One
 * stack per call: given several, `docker stack rm --detach=false` has been
 * seen to hang after removing all but the last.
 */
async function removeStack(name: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await promisify(execFile)(
        "docker",
        ["stack", "rm", "--detach=false", name],
        { timeout: 120_000 },
      );

      return;
    } catch (error) {
      if (attempt === 5) {
        throw error;
      }

      await setTimeout(2_000);
    }
  }
}
