import { expect, it } from "vitest";
import {
  deployRaw,
  image,
  runAction,
  runSuccessfully,
  services,
  stackName,
  variables,
} from "./harness.js";

const compose = `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    configs: [app]
    secrets: [token]
configs:
  app:
    file: ./app.conf
secrets:
  token:
    file: ./token.secret
`;
const files = {
  "compose.yaml": compose,
  "app.conf": "config",
  "token.secret": "secret",
};

function destroy(stack?: string) {
  return runAction(
    {},
    { ...(stack && { "stack-name": stack }), destroy: "true" },
  );
}

// `docker stack rm --detach=false` waits until everything is gone, configs and
// secrets included.
it("removes a stack it deployed", async () => {
  const stack = stackName("teardown");

  await runSuccessfully(files, { "stack-name": stack });
  expect(await variables("config", stack)).toHaveLength(1);

  const run = await destroy(stack);

  expect(run.exitCode, run.log).toBe(0);
  expect(run.outputs).toMatchObject({ status: "success", "stack-name": stack });
  expect(await services(stack)).toEqual({});
  expect(await variables("config", stack)).toEqual([]);
  expect(await variables("secret", stack)).toEqual([]);
});

it("refuses to remove a stack it did not deploy", async () => {
  const stack = stackName("teardown");
  await deployRaw(
    stack,
    `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
`,
  );

  const run = await destroy(stack);

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors.join("\n")).toContain(
    `Refusing to remove stack "${stack}"`,
  );
  expect(Object.keys(await services(stack))).toEqual(["app"]);
});

// `docker stack rm` of a missing stack prints "Nothing found in stack" and
// exits 0, so the action checks for the stack itself.
it("warns about a stack that does not exist", async () => {
  const stack = stackName("teardown");
  const run = await destroy(stack);

  expect(run.exitCode, run.log).toBe(0);
  expect(run.warnings.join("\n")).toContain("nothing to remove");
});

it("requires a stack name", async () => {
  const run = await destroy();

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors.join("\n")).toContain(
    'The "destroy" input requires the "stack-name" input',
  );
});
