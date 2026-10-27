import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigMetadata,
  SecretMetadata,
  ServiceWithMetadata,
} from "../src/engine.js";
import * as engine from "../src/engine.js";
import { destroy } from "../src/teardown.js";

vi.mock("@actions/core");
vi.mock("../src/engine.js");

describe("Teardown", () => {
  const service = (labels: Record<string, string>) =>
    ({
      ID: "svc",
      Spec: { Name: "preview-42_app", Labels: labels },
    }) as ServiceWithMetadata;
  const variable = (labels: Record<string, string>) =>
    ({ ID: "var", Name: "app-env", Labels: labels }) as ConfigMetadata &
      SecretMetadata;
  const withStack = ({
    services = [] as ServiceWithMetadata[],
    configs = [] as ConfigMetadata[],
    secrets = [] as SecretMetadata[],
  }) => {
    vi.mocked(engine.listServices).mockResolvedValue(services);
    vi.mocked(engine.listConfigs).mockResolvedValue(configs);
    vi.mocked(engine.listSecrets).mockResolvedValue(secrets);
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should look up the stack's resources by its namespace", async () => {
    withStack({});

    await destroy({ stack: "preview-42" });

    const filter = { labels: { "com.docker.stack.namespace": "preview-42" } };
    expect(engine.listServices).toHaveBeenCalledWith(filter, true);
    expect(engine.listConfigs).toHaveBeenCalledWith(filter);
    expect(engine.listSecrets).toHaveBeenCalledWith(filter);
  });

  it("should remove a stack whose services carry the deployment labels", async () => {
    withStack({
      services: [service({ "com.matchory.deployment.version": "abc1234" })],
    });

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).toHaveBeenCalledExactlyOnceWith("preview-42");
  });

  it("should remove a stack with configs managed for it", async () => {
    withStack({
      services: [service({})],
      configs: [variable({ "com.matchory.deployment.stack": "preview-42" })],
    });

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).toHaveBeenCalledExactlyOnceWith("preview-42");
  });

  it("should remove a stack with secrets managed for it", async () => {
    withStack({
      secrets: [variable({ "com.matchory.deployment.stack": "preview-42" })],
    });

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).toHaveBeenCalledExactlyOnceWith("preview-42");
  });

  it("should remove what is left of an empty stack", async () => {
    withStack({});

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).toHaveBeenCalledExactlyOnceWith("preview-42");
  });

  it("should refuse to remove a stack it did not deploy", async () => {
    withStack({
      services: [service({ "com.example.team": "web" })],
      configs: [variable({})],
    });

    await expect(destroy({ stack: "preview-42" })).rejects.toThrow(
      'Refusing to remove stack "preview-42"',
    );
    expect(engine.removeStack).not.toHaveBeenCalled();
  });

  it("should not count variables managed for another stack", async () => {
    withStack({
      configs: [variable({ "com.matchory.deployment.stack": "production" })],
    });

    await expect(destroy({ stack: "preview-42" })).rejects.toThrow(
      /Refusing to remove stack/,
    );
    expect(engine.removeStack).not.toHaveBeenCalled();
  });
});
