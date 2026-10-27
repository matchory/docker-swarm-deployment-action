import { expect, it } from "vitest";
import { image, runAction, runSuccessfully, stackName } from "./harness.js";

// Monitoring is only enabled by the Compose file, so the crashing service
// fails the deployment exactly when the file's settings apply.
const files = {
  "compose.yaml": `
x-matchory-deployment:
  monitor: true
  monitor-interval: 1
  monitor-timeout: 10
services:
  app:
    image: ${image}
    command: ["sh", "-c", "exit 2"]
`,
};

it("applies the settings of the Compose file", async () => {
  const stack = stackName("settings");
  const run = await runAction(files, { "stack-name": stack });

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors.at(-1)).toContain("Deployment timed out after 10s");
});

it("lets an input override the Compose file", async () => {
  const stack = stackName("settings");
  const run = await runSuccessfully(files, {
    "stack-name": stack,
    monitor: "false",
  });

  expect(run.log).toContain(
    'The "monitor" input overrides the "monitor" setting in "x-matchory-deployment"',
  );
});
