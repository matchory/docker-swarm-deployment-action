import { describe, expect, it } from "vitest";
import {
  image,
  replicas,
  runAction,
  runSuccessfully,
  stackName,
  tasks,
} from "./harness.js";

function compose(mode: string, command: string, restart?: string) {
  return {
    "compose.yaml": `
services:
  job:
    image: ${image}
    command: ["sh", "-c", "${command}"]
    deploy:
      mode: ${mode}
${restart ? `      restart_policy:\n        condition: ${restart}\n` : ""}`,
  };
}

function monitored(stack: string, timeout = 60) {
  return {
    "stack-name": stack,
    monitor: "true",
    "monitor-interval": "1",
    "monitor-timeout": String(timeout),
  };
}

describe.each(["replicated-job", "global-job"])("%s", (mode) => {
  // A running job reports "1/1 (0/1 completed)", which looks converged to a
  // check of running against desired tasks (#237).
  it("succeeds only once the job has completed", async () => {
    const stack = stackName("jobs");
    await runSuccessfully(compose(mode, "sleep 5"), monitored(stack));

    expect(await replicas(stack, "job")).toMatch(/\(1\/1 completed\)$/);
  });

  // A failed global job reports "0/0 (0/0 completed)", because Swarm stops
  // counting failed global tasks (#237).
  it("fails fast with the exit code", async () => {
    const stack = stackName("jobs");
    const run = await runAction(
      compose(mode, "exit 3", "none"),
      monitored(stack),
    );

    expect(run.exitCode, run.log).toBe(1);
    expect(run.outputs.status).toBe("failure");
    expect(run.errors).toContain(
      `Service "${stack}_job" failed to deploy: Container exited with code 3`,
    );
    expect(run.log).toContain("all tasks are in a failed state");
  });
});

// Every stack deploy re-runs job services, even with an unchanged spec, and
// the completed count starts over for the new run right away.
it("waits for the new run when an unchanged job is redeployed", async () => {
  const stack = stackName("jobs");
  const files = compose("replicated-job", "sleep 5");

  await runSuccessfully(files, monitored(stack));
  await runSuccessfully(files, monitored(stack));

  expect(await replicas(stack, "job")).toBe("0/1 (1/1 completed)");
  expect(
    (await tasks(stack, "job")).filter(({ CurrentState }) =>
      CurrentState.startsWith("Complete"),
    ),
  ).toHaveLength(2);
});

// Stack-deployed jobs default to `restart_policy: any`, so Swarm retries a
// failed job every 5s for as long as it keeps failing.
it("fails a job that Swarm keeps retrying", async () => {
  const stack = stackName("jobs");
  const run = await runAction(
    compose("replicated-job", "exit 3"),
    monitored(stack, 15),
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors).toContain(
    `Service "${stack}_job" failed to deploy: Container exited with code 3`,
  );
  expect(
    (await tasks(stack, "job")).filter(({ CurrentState }) =>
      CurrentState.startsWith("Failed"),
    ).length,
  ).toBeGreaterThan(1);
});
