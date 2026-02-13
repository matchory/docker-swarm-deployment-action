import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceWithMetadata } from "../src/engine.js";
import * as engine from "../src/engine.js";
import {
  isServiceRunning,
  isServiceUpdateComplete,
  monitorDeployment,
} from "../src/monitoring.js";
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
    keyInterpolation: false,
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
          UpdateStatus: { State: "completed" },
        },
      ],
    ] satisfies ServiceWithMetadata[][];
    const listServices = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2])
      .mockResolvedValueOnce(serviceHistory[3])
      .mockResolvedValueOnce(serviceHistory[4])
      .mockResolvedValueOnce(serviceHistory[5]);

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
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([
      {
        message: "Error occurred during service update",
        timestamp: new Date(),
        metadata: {
          "com.docker.swarm.task": "task1",
          "com.docker.swarm.service": "web_service",
        },
      },
      {
        message: "Service is rolling back",
        timestamp: new Date(),
        metadata: {
          "com.docker.swarm.task": "task2",
          "com.docker.swarm.service": "web_service",
        },
      },
    ]);

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

  it("should include task failure details in error message", async () => {
    vi.useFakeTimers();

    const mockTasks = [
      {
        ID: "task1abcdefghijklmnop",
        ServiceID: "web_service",
        NodeID: "node1",
        DesiredState: "shutdown",
        Labels: {},
        Status: {
          State: "failed",
          Err: "task: non-zero exit (1)",
          Message: "started",
        },
        Spec: {},
        CreatedAt: "2024-01-01T00:00:00Z",
        UpdatedAt: "2024-01-01T00:00:02Z",
      },
    ];

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "paused", Message: "update paused due to failure or early termination of task task1abcdefghijklmnop" },
        } as ServiceWithMetadata,
      ],
    ];

    vi.spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0]);
    vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce(mockTasks);
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(monitorDeployment(settings)).rejects.toThrowError(
      /Task task1abcdefg.*task: non-zero exit/,
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(engine.listServiceTasks).toHaveBeenCalledWith("web_service");
  });

  it("should handle task fetch errors gracefully", async () => {
    vi.useFakeTimers();

    const serviceHistory = [
      [
        {
          ID: "web_service",
          Spec: { Name: "test" },
          UpdateStatus: { State: "paused" },
        } as ServiceWithMetadata,
      ],
    ];

    vi.spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0]);
    vi.spyOn(engine, "listServiceTasks").mockRejectedValueOnce(
      new Error("Failed to fetch tasks"),
    );
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

    // Should still throw error even if task fetch fails
    // noinspection JSVoidFunctionReturnValueUsed
    const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(engine.listServiceTasks).toHaveBeenCalled();
  });

  it("should not monitor deployment if `monitor` is false", async () => {
    vi.spyOn(engine, "listServices");

    const noMonitorSettings = defineSettings({
      envVarPrefix: "APP",
      keyInterpolation: false,
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

  describe("edge cases and error handling", () => {
    it("should handle non-Error thrown in monitorDeployment", async () => {
      vi.spyOn(engine, "listServices").mockResolvedValueOnce([
        {
          ID: "svc1",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          UpdateStatus: { State: "updating" },
        },
      ] as Awaited<ReturnType<typeof engine.listServices>>);
      vi.spyOn(engine, "inspectService").mockImplementation(() => {
        throw "string error";
      });
      const settings = defineSettings({
        envVarPrefix: "APP",
        keyInterpolation: false,
        manageVariables: true,
        monitor: true,
        monitorInterval: 1,
        monitorTimeout: 1,
        stack: "test",
        strictVariables: false,
        variables: new Map(),
        version: "1.0.0",
      });
      await expect(monitorDeployment(settings)).rejects.toThrow(
        "Deployment timed out",
      );
    });

    it("should throw error if service update fails", () => {
      expect(() => {
        isServiceUpdateComplete({
          ID: "svc1",
          Name: "svc1",
          Replicas: "1/2",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          UpdateStatus: { State: "rollback_started" },
        });
      }).toThrow(/Update of service/);
    });

    it("should return true if service is still running", () => {
      expect(
        isServiceUpdateComplete({
          ID: "svc1",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          Name: "svc1",
          Replicas: "2/2",
        }),
      ).toBe(true);
    });

    it("should return false if service is partially running", () => {
      expect(
        isServiceRunning({
          ID: "svc1",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          Replicas: "1/2",
        }),
      ).toBe(false);
    });

    it("should return true if service is running and replicas match", () => {
      expect(
        isServiceRunning({
          ID: "svc1",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          Replicas: "2/2",
        }),
      ).toBe(true);
    });

    it("should treat missing UpdateStatus.State as 'updating'", () => {
      // Test case for the issue: when UpdateStatus exists but State is missing
      expect(
        isServiceUpdateComplete({
          ID: "svc1",
          Name: "svc1",
          Replicas: "1/2",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          UpdateStatus: { Message: "Service is updating" },
        }),
      ).toBe(false); // Should return false (still updating)
    });

    it("should treat undefined UpdateStatus.State as 'updating'", () => {
      // Test case for when UpdateStatus.State is explicitly undefined
      expect(
        isServiceUpdateComplete({
          ID: "svc1",
          Name: "svc1",
          Replicas: "1/2",
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          UpdateStatus: {
            State: undefined,
            Message: "Service is updating",
          },
        }),
      ).toBe(false); // Should return false (still updating)
    });

    it("should treat missing UpdateStatus as 'updating' when service is not fully running", () => {
      // New test for missing UpdateStatus with partial replicas
      expect(
        isServiceUpdateComplete({
          ID: "svc1",
          Name: "svc1",
          Replicas: "1/3", // Not fully running
          Spec: { Name: "svc1", Labels: {}, TaskTemplate: {} },
          // UpdateStatus is completely missing
        }),
      ).toBe(false); // Should return false (still updating)
    });
  });
});
