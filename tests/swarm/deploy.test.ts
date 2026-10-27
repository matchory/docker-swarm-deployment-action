import { expect, it } from "vitest";
import {
  image,
  runSuccessfully,
  services,
  stackName,
  tasks,
} from "./harness.js";

const files = {
  "compose.yaml": `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
`,
};

function inputs(stack: string, version: string) {
  return {
    "stack-name": stack,
    version,
    monitor: "true",
    "monitor-interval": "1",
    "monitor-timeout": "60",
  };
}

async function runningTasks(stack: string) {
  return (await tasks(stack, "app"))
    .filter(({ DesiredState }) => DesiredState === "Running")
    .map(({ ID }) => ID);
}

it("labels the services it deploys", async () => {
  const stack = stackName("deploy");
  const run = await runSuccessfully(files, inputs(stack, "v1"));
  expect(run.outputs).toMatchObject({
    status: "success",
    "stack-name": stack,
    version: "v1",
  });

  const { app } = await services(stack);

  expect(app.Spec.Labels).toMatchObject({
    "com.matchory.deployment.version": "v1",
    "com.matchory.deployment.commit":
      "0123456789abcdef0123456789abcdef01234567",
    "com.matchory.deployment.ref": "refs/heads/main",
    "com.matchory.deployment.actor": "swarm-test",
  });

  // Deployment labels belong to the service, not to its containers
  expect(
    Object.keys(app.Spec.TaskTemplate.ContainerSpec.Labels ?? {}).filter(
      (label) => label.startsWith("com.matchory.deployment."),
    ),
  ).toEqual([]);
});

// Changing only `deploy.labels` updates the service in place: the tasks keep
// running, and Swarm records no update.
it("keeps the tasks of a redeploy that only changes the version", async () => {
  const stack = stackName("deploy");

  await runSuccessfully(files, inputs(stack, "v1"));
  const before = await runningTasks(stack);

  await runSuccessfully(files, inputs(stack, "v2"));
  const { app } = await services(stack);

  expect(app.Spec.Labels?.["com.matchory.deployment.version"]).toBe("v2");
  expect(app.UpdateStatus).toBeUndefined();
  expect(await runningTasks(stack)).toEqual(before);
  expect(before).toHaveLength(1);
});
