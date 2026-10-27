import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigMetadata,
  SecretMetadata,
  ServiceMetadata,
} from "../src/engine.js";
import * as engine from "../src/engine.js";
import { destroy } from "../src/teardown.js";

vi.mock("@actions/core");
vi.mock("../src/engine.js");

describe("Teardown", () => {
  const service = { ID: "svc", Name: "preview-42_app" } as ServiceMetadata;
  const variable = (labels: Record<string, string>) =>
    ({ ID: "var", Name: "app-env", Labels: labels }) as ConfigMetadata &
      SecretMetadata;

  // Answers the unfiltered and the deployment-label service listings
  const withStack = ({
    services = [] as ServiceMetadata[],
    labelled = [] as ServiceMetadata[],
    configs = [] as ConfigMetadata[],
    secrets = [] as SecretMetadata[],
  }) => {
    vi.mocked(engine.listServices).mockImplementation((async ({ labels }) =>
      Array.isArray(labels)
        ? labelled
        : services) as typeof engine.listServices);
    vi.mocked(engine.listConfigs).mockResolvedValue(configs);
    vi.mocked(engine.listSecrets).mockResolvedValue(secrets);
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should look up the stack's resources with label filters", async () => {
    withStack({});

    await destroy({ stack: "preview-42" });

    const namespace = { "com.docker.stack.namespace": "preview-42" };
    expect(engine.listServices).toHaveBeenCalledWith({ labels: namespace });
    expect(engine.listServices).toHaveBeenCalledWith({
      labels: [namespace, "com.matchory.deployment.version"],
    });
    expect(engine.listConfigs).toHaveBeenCalledWith({ labels: namespace });
    expect(engine.listSecrets).toHaveBeenCalledWith({ labels: namespace });
  });

  it("should remove a stack whose services carry the deployment labels", async () => {
    withStack({ services: [service], labelled: [service] });

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).toHaveBeenCalledExactlyOnceWith("preview-42");
  });

  it("should remove a stack with configs managed for it", async () => {
    withStack({
      services: [service],
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

  it("should warn instead of removing a stack with nothing to verify", async () => {
    withStack({});

    await destroy({ stack: "preview-42" });

    expect(engine.removeStack).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Stack "preview-42" has no services, configs or secrets',
      ),
    );
  });

  it("should refuse to remove a stack it did not deploy", async () => {
    withStack({ services: [service], configs: [variable({})] });

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
