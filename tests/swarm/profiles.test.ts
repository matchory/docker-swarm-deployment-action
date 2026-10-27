import { expect, it } from "vitest";
import {
  image,
  runAction,
  runSuccessfully,
  services,
  stackName,
} from "./harness.js";

const service = `
    image: ${image}
    command: ["sleep", "86400"]`;

async function deployed(stack: string) {
  return Object.keys(await services(stack)).sort();
}

it("combines profiles across files and interpolates their names", async () => {
  const stack = stackName("profiles");
  await runSuccessfully(
    {
      "compose.yaml": `
services:
  always:${service}
  staging:${service}
    profiles: [staging]
  tools:${service}
    profiles: [tools]
  interpolated:${service}
    profiles: ["\${PROFILE}"]
`,
      "compose.override.yaml": `
services:
  tools:
    profiles: [staging]
`,
    },
    {
      "stack-name": stack,
      "compose-file": "compose.yaml:compose.override.yaml",
      profiles: "staging",
      variables: "PROFILE=staging",
    },
  );

  expect(await deployed(stack)).toEqual([
    "always",
    "interpolated",
    "staging",
    "tools",
  ]);
});

it("drops profiles with !reset and !override, and inherits them with extends", async () => {
  const stack = stackName("profiles");
  await runSuccessfully(
    {
      "compose.yaml": `
services:
  base:${service}
    profiles: [tools]
  derived:
    extends: base
  reset:${service}
    profiles: [tools]
  overridden:${service}
    profiles: [tools]
`,
      "compose.override.yaml": `
services:
  reset:
    profiles: !reset []
  overridden: !override${service}
`,
    },
    {
      "stack-name": stack,
      "compose-file": "compose.yaml:compose.override.yaml",
      profiles: "staging",
    },
  );

  expect(await deployed(stack)).toEqual(["overridden", "reset"]);
});

it("skips the env files and dependencies of skipped services", async () => {
  const stack = stackName("profiles");
  const run = await runSuccessfully(
    {
      "compose.yaml": `
services:
  app:${service}
    depends_on:
      tools:
        condition: service_started
  tools:${service}
    profiles: [tools]
    env_file: ./missing.env
`,
    },
    { "stack-name": stack, profiles: "staging" },
  );

  expect(await deployed(stack)).toEqual(["app"]);
  expect(run.warnings).toContainEqual(
    expect.stringContaining('Service "app" depends on service "tools"'),
  );
});

it("refuses to deploy a service that extends a skipped one", async () => {
  const stack = stackName("profiles");
  const run = await runAction(
    {
      "compose.yaml": `
services:
  base:${service}
    profiles: [tools]
  derived:
    extends: base
    profiles: [staging]
`,
    },
    { "stack-name": stack, profiles: "staging" },
  );

  expect(run.exitCode, run.log).toBe(1);
  expect(run.errors.join("\n")).toContain(
    'Service "derived" extends service "base", which is not deployed',
  );
  expect(await deployed(stack)).toEqual([]);
});
