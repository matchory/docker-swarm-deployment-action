import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceWithMetadata } from "../src/engine.js";
import * as engine from "../src/engine.js";
import { monitorDeployment } from "../src/monitoring.js";
import { defineSettings } from "../src/settings.js";

vi.mock("@actions/core");

describe("Monitoring", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  const settings = defineSettings({
    envVarPrefix: "APP",
    manageVariables: true,
    monitor: true,
    monitorInterval: 5,
    monitorTimeout: 300,
    stack: "testso",
    strictVariables: false,
    variables: new Map(),
    version: "1.0.0",
  });

  it("should monitor deployment until all services are updated", async () => {
    vi.useFakeTimers();

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
      ] as ServiceWithMetadata[],
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
      ] as ServiceWithMetadata[],
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
      ] as ServiceWithMetadata[],
    ] as ServiceWithMetadata[][];
    vi.spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const monitorPromise = monitorDeployment(settings);
    await vi.runAllTimersAsync();
    await monitorPromise;

    expect(engine.listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should wait until all services progress to completed", async () => {
    vi.useFakeTimers();

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        } as ServiceWithMetadata,
      ],
    ];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const promise = monitorDeployment(settings);
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should wait until all tasks are spawned", async () => {
    vi.useFakeTimers();

    const serviceHistory = [
      [
        {
          ID: "a",
          Image: "web:latest",
          Mode: "replicated",
          Name: "web_service",
          Ports: "",
          Replicas: "0/3",
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
          Endpoint: {},
          Version: { Index: 0 },
          PreviousSpec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          Spec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          UpdateStatus: { State: "updating" },
        },
      ],
      [
        {
          ID: "a",
          Image: "web:latest",
          Mode: "replicated",
          Name: "web_service",
          Ports: "",
          Replicas: "1/3",
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
          Endpoint: {},
          Version: { Index: 0 },
          PreviousSpec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          Spec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          UpdateStatus: { State: "updating" },
        },
      ],
      [
        {
          ID: "a",
          Image: "web:latest",
          Mode: "replicated",
          Name: "web_service",
          Ports: "",
          Replicas: "2/3",
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
          Endpoint: {},
          Version: { Index: 0 },
          PreviousSpec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          Spec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          UpdateStatus: { State: "updating" },
        },
      ],
      [
        {
          ID: "a",
          Image: "web:latest",
          Mode: "replicated",
          Name: "web_service",
          Ports: "",
          Replicas: "2/3",
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
          Endpoint: {},
          Version: { Index: 0 },
          PreviousSpec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          Spec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          UpdateStatus: { State: "updating" },
        },
      ],
      [
        {
          ID: "a",
          Image: "web:latest",
          Mode: "replicated",
          Name: "web_service",
          Ports: "",
          Replicas: "3/3",
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
          Endpoint: {},
          Version: { Index: 0 },
          PreviousSpec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          Spec: {
            Name: "web_service",
            Labels: {},
            TaskTemplate: {},
          },
          UpdateStatus: { State: "updating" },
        },
      ],
    ] satisfies ServiceWithMetadata[][];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2])
      .mockResolvedValueOnce(serviceHistory[3])
      .mockResolvedValueOnce(serviceHistory[4]);

    const promise = monitorDeployment(settings);
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should fail if a service is rolled back", async () => {
    vi.useFakeTimers();

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "rollback_started" },
        } as ServiceWithMetadata,
      ],
    ];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
  });

  it("should fail if the update takes too long", async () => {
    vi.useFakeTimers();

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "completed" },
        } as ServiceWithMetadata,
      ],
    ];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(
      monitorDeployment({
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

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ],
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "rollback_started" },
        } as ServiceWithMetadata,
      ],
    ];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
    expect(engine.getServiceLogs).toHaveBeenCalledWith(
      serviceHistory[2][0].ID,
      expect.objectContaining({
        since: expect.any(Date),
      }),
    );
  });

  it("should not monitor deployment if `monitor` is false", async () => {
    vi.spyOn(engine, "listServices");

    const noMonitorSettings = defineSettings({
      envVarPrefix: "APP",
      manageVariables: true,
      monitor: false,
      monitorInterval: 5,
      monitorTimeout: 300,
      stack: "test",
      strictVariables: false,
      variables: new Map(),
      version: "1.0.0",
    });

    await monitorDeployment(noMonitorSettings);

    expect(engine.listServices).not.toHaveBeenCalled();
  });
});
