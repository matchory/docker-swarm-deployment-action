import { expect, it } from "vitest";
import {
  docker,
  image,
  runSuccessfully,
  services,
  stackName,
  variables,
} from "./harness.js";

function files(content: string) {
  return {
    "compose.yaml": `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    configs:
      - source: app
        target: /app.conf
configs:
  app:
    file: ./app.conf
`,
    "app.conf": content,
  };
}

async function data(kind: "config" | "secret", name: string) {
  const encoded = await docker(
    kind,
    "inspect",
    "--format",
    "{{json .Spec.Data}}",
    name,
  );

  return Buffer.from(JSON.parse(encoded), "base64").toString();
}

// Swarm refuses to remove a config the current spec references, but not one
// only the previous spec does, which a rollback would restore.
it("rotates a changed config and keeps the one a rollback needs", async () => {
  const stack = stackName("vars");
  const inputs = { "stack-name": stack };
  const deployed: string[][] = [];

  for (const content of ["one", "two", "three"]) {
    await runSuccessfully(files(content), inputs);
    deployed.push(await variables("config", stack));
  }

  const [first, second, third] = deployed;

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(2);
  expect(second).toContain(first[0]);
  expect(third).toHaveLength(2);
  expect(third).not.toContain(first[0]);
  expect(third).toContain(second.find((name) => name !== first[0]));

  const { app } = await services(stack);
  const [current] = app.Spec.TaskTemplate.ContainerSpec.Configs ?? [];

  expect(await data("config", current.ConfigName)).toBe("three");
});

// `docker stack deploy` rejects `content:` and `environment:` variables, so the
// action writes them to files first.
it("deploys content and environment variables", async () => {
  const stack = stackName("vars");
  const run = await runSuccessfully(
    {
      "compose.yaml": `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    configs: [greeting]
    secrets: [token]
configs:
  greeting:
    content: hello \${NAME}
secrets:
  token:
    environment: TOKEN
`,
    },
    {
      "stack-name": stack,
      variables: "NAME=world",
      secrets: "TOKEN=s3cret",
    },
  );

  const [config] = await variables("config", stack);
  const [secret] = await variables("secret", stack);

  expect(await data("config", config)).toBe("hello world");
  expect(secret).toBeDefined();
  // Masked by the runner: the value appears only to register the mask
  expect(run.log.replace(/^::add-mask::.*$/gm, "")).not.toContain("s3cret");
});
