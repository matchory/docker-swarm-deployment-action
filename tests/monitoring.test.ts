import * as core from "@actions/core";
import { type Service } from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/deployment.js";
import { monitorDeployment } from "../src/monitoring.js";
import { defineSettings } from "../src/settings.js";
import type { ServiceInfo } from "../src/types.js";

vi.mock("@actions/core");

describe("Monitoring", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  const settings = defineSettings({
    stack: "test",
    version: "1.0.0",
    envVarPrefix: "APP",
    monitor: true,
    monitorTimeout: 300,
    monitorInterval: 5,
  });

  it("should monitor deployment until all services are updated", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        },
        {
          ID: "db_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        },
      ] satisfies ServiceInfo[],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        },
        {
          ID: "db_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        },
      ] satisfies ServiceInfo[],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        },
        {
          ID: "db_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        },
      ] satisfies ServiceInfo[],
    ] as unknown as Service[][];
    vi.spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const monitorPromise = monitorDeployment(client, settings);
    await vi.runAllTimersAsync();
    await monitorPromise;

    expect(client.listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should wait until all services progress to completed", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        } satisfies ServiceInfo,
      ],
    ] as unknown as Service[][];
    const listServices = vi
      .spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const promise = monitorDeployment(client, settings);
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should wait until all tasks are spawned", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          ServiceStatus: {
            RunningTasks: 1,
            DesiredTasks: 3,
            CompletedTasks: 0,
          },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          ServiceStatus: {
            RunningTasks: 3,
            DesiredTasks: 3,
            CompletedTasks: 0,
          },
        } satisfies ServiceInfo,
      ],
    ] as unknown as Service[][];
    const listServices = vi
      .spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const promise = monitorDeployment(client, settings);
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should fail if a service is rolled back", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "rollback_started" },
        } satisfies ServiceInfo,
      ],
    ] as unknown as Service[][];
    const listServices = vi
      .spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(
      monitorDeployment(client, settings),
    ).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should fail if the update takes too long", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        } satisfies ServiceInfo,
      ],
    ] as unknown as Service[][];
    const listServices = vi
      .spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(
      monitorDeployment(client, {
        ...settings,
        monitorTimeout: 3,
        monitorInterval: 1,
      }),
    ).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should print the service logs on failure", async () => {
    vi.useFakeTimers();

    const client = createClient(settings);
    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } satisfies ServiceInfo,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "rollback_started" },
        } satisfies ServiceInfo,
      ],
    ] as unknown as Service[][];
    const listServices = vi
      .spyOn(client, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);
    vi.spyOn(client, "getService").mockImplementationOnce(
      () =>
        ({
          logs: vi.fn().mockResolvedValueOnce(Buffer.from("__marker__")),
        }) as unknown as Service,
    );

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(
      monitorDeployment(client, settings),
    ).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("__marker__"),
    );
  });

  it("should not monitor deployment if `monitor` is false", async () => {
    const client = createClient(settings);

    vi.spyOn(client, "listServices");

    const noMonitorSettings = defineSettings({
      stack: "test",
      version: "1.0.0",
      envVarPrefix: "APP",
      monitor: false,
      monitorTimeout: 300,
      monitorInterval: 5,
    });

    await monitorDeployment(client, noMonitorSettings);

    expect(client.listServices).not.toHaveBeenCalled();
  });
});
