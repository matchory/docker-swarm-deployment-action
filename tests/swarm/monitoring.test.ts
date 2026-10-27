import { expect, it } from "vitest";
import { image, runAction, runSuccessfully, stackName } from "./harness.js";

function monitored(stack: string, timeout = 60) {
  return {
    "stack-name": stack,
    monitor: "true",
    "monitor-interval": "1",
    "monitor-timeout": String(timeout),
  };
}

function compose(services: string) {
  return { "compose.yaml": `services:\n${services}` };
}

const crashing = (labels = "") => `
    image: ${image}
    command: ["sh", "-c", "exit 2"]
${labels ? `    deploy:\n      labels:\n${labels}` : ""}`;

const running = `
    image: ${image}
    command: ["sleep", "86400"]
`;

it("fails fast on an image that does not exist", async () => {
  const stack = stackName("monitor");
  const run = await runAction(
    compose(`  app:\n    image: ${image}-does-not-exist\n`),
    monitored(stack),
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors[0]).toMatch(
    new RegExp(
      `^Service "${stack}_app" failed to deploy: Image could not be pulled: `,
    ),
  );
  expect(run.log).toContain("all tasks are in a failed state");
});

// Swarm restarts a crashing container every 5s, so there is always a task on
// its way to running, and the service never counts as stuck.
it("fails a crash loop with the exit code", async () => {
  const stack = stackName("monitor");
  const run = await runAction(
    compose(`  app:${crashing()}`),
    monitored(stack, 15),
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors).toContain(
    `Service "${stack}_app" failed to deploy: Container exited with code 2`,
  );
  expect(run.errors.at(-1)).toContain("Deployment timed out after 15s");
});

it("fails a service whose health check fails", async () => {
  const stack = stackName("monitor");
  const run = await runAction(
    compose(`  app:${running}    healthcheck:
      test: ["CMD", "false"]
      interval: 1s
      timeout: 1s
      retries: 1
`),
    monitored(stack, 20),
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors).toContain(
    `Service "${stack}_app" failed to deploy: Container failed health check`,
  );
});

it("ignores a service that opts out of monitoring", async () => {
  const stack = stackName("monitor");
  const run = await runSuccessfully(
    compose(
      `  app:${running}  worker:${crashing(
        `        com.matchory.deployment.monitor: "false"\n`,
      )}`,
    ),
    monitored(stack),
  );

  expect(run.log).toContain(
    `Service "${stack}_app" has been deployed successfully`,
  );
  expect(run.log).not.toContain(`${stack}_worker" failed`);
});

it("enforces the monitor timeout of a service", async () => {
  const stack = stackName("monitor");
  const started = Date.now();
  const run = await runAction(
    compose(
      `  app:${running}  worker:${crashing(
        `        com.matchory.deployment.monitor-timeout: "10"\n`,
      )}`,
    ),
    monitored(stack, 300),
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors.at(-1)).toContain("Deployment timed out after 10s");
  expect(run.errors).toContain(
    `Service "${stack}_worker" failed to deploy: Container exited with code 2`,
  );
  expect(Date.now() - started).toBeLessThan(60_000);
});
