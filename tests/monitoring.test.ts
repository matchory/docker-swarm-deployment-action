import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceWithMetadata, TaskStatus } from "../src/engine.js";
import * as engine from "../src/engine.js";
import {
  buildFailureReport,
  categorizeTaskError,
  isServiceRunning,
  isServiceStuck,
  isServiceUpdateComplete,
  monitorDeployment,
} from "../src/monitoring.js";
import { defineSettings } from "../src/settings.js";
import * as utilsModule from "../src/utils.js";

vi.mock("@actions/core");

describe("Monitoring", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    // Default: services are not stuck (isServiceStuck returns false)
    vi.spyOn(engine, "listServiceTasks").mockResolvedValue([]);
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
    const listServicesSpy = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const runningTask = {
      ID: "t1",
      Name: "test.1",
      Image: "img",
      Node: "n1",
      DesiredState: "Running",
      CurrentState: "Running 10 seconds ago",
      Error: "",
      Ports: "",
    };
    const failedTask = {
      ID: "t1",
      Name: "test.1",
      Image: "img",
      Node: "n1",
      DesiredState: "Shutdown",
      CurrentState: "Failed 1 minute ago",
      Error: "task: non-zero exit (1)",
      Ports: "",
    };
    vi.spyOn(engine, "listServiceTasks")
      .mockResolvedValueOnce([runningTask]) // isServiceStuck check (iteration 1)
      .mockResolvedValueOnce([runningTask]) // isServiceStuck check (iteration 2)
      .mockResolvedValueOnce([failedTask]); // buildFailureReport (iteration 3, after rollback detected)
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

    const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServicesSpy).toHaveBeenCalledTimes(serviceHistory.length);
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
    ).rejects.toThrow(/Deployment timed out/);
    await vi.runAllTimersAsync();
    await promise;

    expect(listServices).toHaveBeenCalled();
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
    const listServicesSpy = vi
      .spyOn(engine, "listServices")
      .mockResolvedValueOnce(serviceHistory[0])
      .mockResolvedValueOnce(serviceHistory[1])
      .mockResolvedValueOnce(serviceHistory[2]);

    const runningTask = {
      ID: "t1",
      Name: "test.1",
      Image: "img",
      Node: "n1",
      DesiredState: "Running",
      CurrentState: "Running 10 seconds ago",
      Error: "",
      Ports: "",
    };
    const failedTask = {
      ID: "t1",
      Name: "test.1",
      Image: "img",
      Node: "n1",
      DesiredState: "Shutdown",
      CurrentState: "Failed 1 minute ago",
      Error: "task: non-zero exit (1)",
      Ports: "",
    };
    vi.spyOn(engine, "listServiceTasks")
      .mockResolvedValueOnce([runningTask]) // isServiceStuck (iteration 1)
      .mockResolvedValueOnce([runningTask]) // isServiceStuck (iteration 2)
      .mockResolvedValueOnce([failedTask]); // buildFailureReport (iteration 3)
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([
      {
        message: "Error occurred during service update",
        timestamp: new Date(),
      },
      { message: "Service is rolling back", timestamp: new Date() },
    ]);

    const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
    await vi.runAllTimersAsync();
    await promise;

    expect(listServicesSpy).toHaveBeenCalledTimes(serviceHistory.length);
    expect(engine.getServiceLogs).toHaveBeenCalledWith(
      "web_service",
      expect.objectContaining({ since: expect.any(Date), tail: 50 }),
    );

    const core = await import("@actions/core");
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("Error occurred during service update"),
    );
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
        /Deployment timed out/,
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

  describe("buildFailureReport", () => {
    it("should produce a headline from the most recent failed task", async () => {
      const core = await import("@actions/core");
      const tasks: TaskStatus[] = [
        {
          ID: "t1",
          Name: "api.1",
          Image: "registry/api:v2",
          Node: "worker-1",
          DesiredState: "Shutdown",
          CurrentState: "Failed 2 minutes ago",
          Error: "task: non-zero exit (1)",
          Ports: "",
        },
        {
          ID: "t2",
          Name: "api.2",
          Image: "registry/api:v2",
          Node: "worker-2",
          DesiredState: "Shutdown",
          CurrentState: "Failed 1 minute ago",
          Error: "task: non-zero exit (1)",
          Ports: "",
        },
      ];
      vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce(tasks);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

      await buildFailureReport("svc1", "api", new Date());

      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("Container exited with code 1"),
      );
    });

    it("should show task attempt history", async () => {
      const core = await import("@actions/core");
      const tasks: TaskStatus[] = [
        {
          ID: "t1",
          Name: "api.1",
          Image: "img",
          Node: "worker-1",
          DesiredState: "Shutdown",
          CurrentState: "Failed 3 minutes ago",
          Error: "task: non-zero exit (1)",
          Ports: "",
        },
        {
          ID: "t2",
          Name: "api.2",
          Image: "img",
          Node: "worker-1",
          DesiredState: "Running",
          CurrentState: "Running 30 seconds ago",
          Error: "",
          Ports: "",
        },
      ];
      vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce(tasks);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

      await buildFailureReport("svc1", "api", new Date());

      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("Task history"),
      );
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("worker-1"),
      );
    });

    it("should show explicit message when no container logs are available", async () => {
      const core = await import("@actions/core");
      vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce([
        {
          ID: "t1",
          Name: "api.1",
          Image: "img",
          Node: "n1",
          DesiredState: "Shutdown",
          CurrentState: "Failed 1 minute ago",
          Error: "No such image: img",
          Ports: "",
        },
      ]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

      await buildFailureReport("svc1", "api", new Date());

      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("No container logs available"),
      );
    });

    it("should show container logs when available", async () => {
      const core = await import("@actions/core");
      vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce([
        {
          ID: "t1",
          Name: "api.1",
          Image: "img",
          Node: "n1",
          DesiredState: "Shutdown",
          CurrentState: "Failed 1 minute ago",
          Error: "task: non-zero exit (1)",
          Ports: "",
        },
      ]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([
        {
          timestamp: new Date("2026-03-28T12:00:01Z"),
          message: "Error: Cannot connect to database",
        },
        {
          timestamp: new Date("2026-03-28T12:00:02Z"),
          message: "Shutting down...",
        },
      ]);

      await buildFailureReport("svc1", "api", new Date());

      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("Cannot connect to database"),
      );
    });

    it("should handle empty task list gracefully", async () => {
      const core = await import("@actions/core");
      vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce([]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

      await buildFailureReport("svc1", "api", new Date());

      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("No task information available"),
      );
    });
  });

  describe("isServiceStuck", () => {
    it("should return true when all tasks are rejected", () => {
      expect(
        isServiceStuck([
          {
            ID: "t1",
            Name: "api.1",
            Image: "img",
            Node: "n1",
            DesiredState: "Shutdown",
            CurrentState: "Rejected 1 minute ago",
            Error: "No such image: img",
            Ports: "",
          },
          {
            ID: "t2",
            Name: "api.1",
            Image: "img",
            Node: "n1",
            DesiredState: "Shutdown",
            CurrentState: "Rejected 2 minutes ago",
            Error: "No such image: img",
            Ports: "",
          },
        ]),
      ).toBe(true);
    });

    it("should return true when all tasks are failed", () => {
      expect(
        isServiceStuck([
          {
            ID: "t1",
            Name: "api.1",
            Image: "img",
            Node: "n1",
            DesiredState: "Shutdown",
            CurrentState: "Failed 1 minute ago",
            Error: "task: non-zero exit (1)",
            Ports: "",
          },
        ]),
      ).toBe(true);
    });

    it("should return false when some tasks are running", () => {
      expect(
        isServiceStuck([
          {
            ID: "t1",
            Name: "api.1",
            Image: "img",
            Node: "n1",
            DesiredState: "Shutdown",
            CurrentState: "Failed 1 minute ago",
            Error: "task: non-zero exit (1)",
            Ports: "",
          },
          {
            ID: "t2",
            Name: "api.2",
            Image: "img",
            Node: "n1",
            DesiredState: "Running",
            CurrentState: "Running 30 seconds ago",
            Error: "",
            Ports: "",
          },
        ]),
      ).toBe(false);
    });

    it("should return false when tasks are being prepared", () => {
      expect(
        isServiceStuck([
          {
            ID: "t1",
            Name: "api.1",
            Image: "img",
            Node: "n1",
            DesiredState: "Running",
            CurrentState: "Preparing 5 seconds ago",
            Error: "",
            Ports: "",
          },
        ]),
      ).toBe(false);
    });

    it("should return false when there are no tasks", () => {
      expect(isServiceStuck([])).toBe(false);
    });
  });

  describe("categorizeTaskError", () => {
    it("should categorize image pull failures", () => {
      expect(categorizeTaskError("No such image: registry/app:v2")).toEqual({
        category: "image_pull",
        headline: "Image could not be pulled: No such image: registry/app:v2",
      });
      expect(categorizeTaskError("manifest unknown")).toEqual({
        category: "image_pull",
        headline: "Image could not be pulled: manifest unknown",
      });
      expect(
        categorizeTaskError("pull access denied for registry/app"),
      ).toEqual({
        category: "image_pull",
        headline:
          "Image could not be pulled: pull access denied for registry/app",
      });
      expect(
        categorizeTaskError("unauthorized: authentication required"),
      ).toEqual({
        category: "image_pull",
        headline:
          "Image could not be pulled: unauthorized: authentication required",
      });
    });

    it("should categorize OOM kills (exit 137) before general crashes", () => {
      expect(categorizeTaskError("task: non-zero exit (137)")).toEqual({
        category: "oom_kill",
        headline: "Container killed (likely OOM): exit code 137",
      });
    });

    it("should categorize container crashes", () => {
      expect(categorizeTaskError("task: non-zero exit (1)")).toEqual({
        category: "container_crash",
        headline: "Container exited with code 1",
      });
      expect(
        categorizeTaskError("task: non-zero exit (127): exec not found"),
      ).toEqual({
        category: "container_crash",
        headline: "Container exited with code 127",
      });
    });

    it("should categorize health check failures", () => {
      expect(categorizeTaskError("dockerexec: unhealthy container")).toEqual({
        category: "health_check",
        headline: "Container failed health check",
      });
    });

    it("should categorize scheduling failures", () => {
      expect(
        categorizeTaskError(
          "no suitable node (insufficient resources on 2 nodes)",
        ),
      ).toEqual({
        category: "scheduling",
        headline:
          "No node available to run this task: no suitable node (insufficient resources on 2 nodes)",
      });
    });

    it("should categorize container startup failures", () => {
      expect(
        categorizeTaskError(
          "starting container failed: OCI runtime create failed",
        ),
      ).toEqual({
        category: "startup_failure",
        headline:
          "Container failed to start: starting container failed: OCI runtime create failed",
      });
    });

    it("should categorize network errors", () => {
      expect(
        categorizeTaskError("failed to allocate network IP for task"),
      ).toEqual({
        category: "network",
        headline:
          "Network allocation failed: failed to allocate network IP for task",
      });
    });

    it("should categorize volume errors", () => {
      expect(
        categorizeTaskError(
          "invalid bind mount source, source path not found: /data",
        ),
      ).toEqual({
        category: "volume",
        headline:
          "Volume or mount failed: invalid bind mount source, source path not found: /data",
      });
    });

    it("should categorize secret/config errors", () => {
      expect(
        categorizeTaskError("secret reference my_secret not found"),
      ).toEqual({
        category: "config",
        headline:
          "Secret or config reference invalid: secret reference my_secret not found",
      });
    });

    it("should categorize dependency errors", () => {
      expect(categorizeTaskError("dependency not ready")).toEqual({
        category: "dependency",
        headline: "Task dependencies not yet available",
      });
    });

    it("should categorize entrypoint errors", () => {
      expect(
        categorizeTaskError("OCI runtime create failed: exec format error"),
      ).toEqual({
        category: "entrypoint",
        headline:
          "Container entrypoint failed: OCI runtime create failed: exec format error",
      });
    });

    it("should categorize port conflicts", () => {
      expect(
        categorizeTaskError("host-mode port already in use on 1 node"),
      ).toEqual({
        category: "port_conflict",
        headline:
          "Host port already in use: host-mode port already in use on 1 node",
      });
    });

    it("should fall back to unknown for unrecognized errors", () => {
      expect(categorizeTaskError("something completely unexpected")).toEqual({
        category: "unknown",
        headline: "something completely unexpected",
      });
    });

    it("should handle empty error string", () => {
      expect(categorizeTaskError("")).toEqual({
        category: "unknown",
        headline: "Unknown error",
      });
    });
  });

  describe("exponential backoff", () => {
    it("should increase sleep interval between polls", async () => {
      vi.useFakeTimers();

      const sleepSpy = vi.spyOn(utilsModule, "sleep");

      // 3 polls: updating, updating, completed
      vi.spyOn(engine, "listServices")
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "updating" },
          } as ServiceWithMetadata,
        ])
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "updating" },
          } as ServiceWithMetadata,
        ])
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "completed" },
          } as ServiceWithMetadata,
        ]);

      const promise = monitorDeployment(settings);
      await vi.runAllTimersAsync();
      await promise;

      // Sleep happens after each poll only while services are still pending.
      // Poll 1 (updating): sleep 7500 (5000 * 1.5 after no progress)
      // Poll 2 (updating): sleep 11250 (7500 * 1.5 after no progress)
      // Poll 3 (completed): no sleep (all done)
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 7_500);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 11_250);
    });

    it("should cap the backoff interval at monitorInterval * 6", async () => {
      vi.useFakeTimers();

      const sleepSpy = vi.spyOn(utilsModule, "sleep");

      // Many polls to hit the cap
      const updatingService = [
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "updating" },
        } as ServiceWithMetadata,
      ];
      const completedService = [
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "completed" },
        } as ServiceWithMetadata,
      ];

      const listServicesSpy = vi.spyOn(engine, "listServices");
      // Enough iterations to exceed the cap: 5, 7.5, 11.25, 16.875, 25.3125, 30 (capped), 30
      for (let i = 0; i < 8; i++) {
        listServicesSpy.mockResolvedValueOnce(updatingService);
      }
      listServicesSpy.mockResolvedValueOnce(completedService);

      const promise = monitorDeployment({
        ...settings,
        monitorTimeout: 600,
      });
      await vi.runAllTimersAsync();
      await promise;

      // The cap is 5 * 6 = 30_000ms. Find the max sleep value.
      const sleepValues = sleepSpy.mock.calls.map((c) => c[0]);
      const maxSleep = Math.max(...sleepValues);
      expect(maxSleep).toBe(30_000);
    });

    it("should reset interval when a service completes", async () => {
      vi.useFakeTimers();

      const sleepSpy = vi.spyOn(utilsModule, "sleep");

      // svc1 completes on poll 3, svc2 still updating, then completes
      vi.spyOn(engine, "listServices")
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "updating" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "updating" },
          },
        ] as ServiceWithMetadata[])
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "updating" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "updating" },
          },
        ] as ServiceWithMetadata[])
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "completed" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "updating" },
          },
        ] as ServiceWithMetadata[])
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "completed" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "completed" },
          },
        ] as ServiceWithMetadata[]);

      const promise = monitorDeployment(settings);
      await vi.runAllTimersAsync();
      await promise;

      const sleepValues = sleepSpy.mock.calls.map((c) => c[0]);
      // Poll 1 (both updating, no progress): sleep 7500
      // Poll 2 (both updating, no progress): sleep 11250
      // Poll 3 (svc1 completes, reset): sleep 5000 (reset, svc2 still pending)
      // Poll 4 (svc2 completes): no sleep (all done)
      expect(sleepValues[2]).toBe(5_000);
    });
  });

  describe("partial success reporting", () => {
    it("should report converged and pending services on timeout", async () => {
      vi.useFakeTimers();
      const core = await import("@actions/core");

      // svc1 completes, svc2 stays updating until timeout
      vi.spyOn(engine, "listServices")
        .mockResolvedValueOnce([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "completed" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "updating" },
          },
        ] as ServiceWithMetadata[])
        .mockResolvedValue([
          {
            ID: "svc1",
            Spec: { Name: "web" },
            UpdateStatus: { State: "completed" },
          },
          {
            ID: "svc2",
            Spec: { Name: "api" },
            UpdateStatus: { State: "updating" },
          },
        ] as ServiceWithMetadata[]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValue([]);

      const promise = expect(
        monitorDeployment({
          ...settings,
          monitorTimeout: 3,
          monitorInterval: 1,
        }),
      ).rejects.toThrow(/1\/2 services converged/);
      await vi.runAllTimersAsync();
      await promise;

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Services converged: web"),
      );
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining("Services not converged: api"),
      );
    });

    it("should include a job summary table on timeout", async () => {
      vi.useFakeTimers();
      const core = await import("@actions/core");

      vi.spyOn(engine, "listServices").mockResolvedValue([
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "completed" },
        },
        {
          ID: "svc2",
          Spec: { Name: "api" },
          UpdateStatus: { State: "updating" },
        },
      ] as ServiceWithMetadata[]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValue([]);

      const promise = expect(
        monitorDeployment({
          ...settings,
          monitorTimeout: 3,
          monitorInterval: 1,
        }),
      ).rejects.toThrow();
      await vi.runAllTimersAsync();
      await promise;

      expect(core.summary.addHeading).toHaveBeenCalledWith(
        "Deployment timeout summary",
        2,
      );
      expect(core.summary.addTable).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ data: "web" }),
            expect.objectContaining({ data: "Converged" }),
          ]),
          expect.arrayContaining([
            expect.objectContaining({ data: "api" }),
            expect.objectContaining({ data: "Pending" }),
          ]),
        ]),
      );
    });

    it("should report 0/N when no services converged", async () => {
      vi.useFakeTimers();

      vi.spyOn(engine, "listServices").mockResolvedValue([
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "updating" },
        },
      ] as ServiceWithMetadata[]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValue([]);

      const promise = expect(
        monitorDeployment({
          ...settings,
          monitorTimeout: 3,
          monitorInterval: 1,
        }),
      ).rejects.toThrow(/0\/1 services converged/);
      await vi.runAllTimersAsync();
      await promise;
    });
  });

  describe("parallel service checks", () => {
    it("should fetch tasks for all stuck services in parallel", async () => {
      vi.useFakeTimers();

      const stuckTask: TaskStatus = {
        ID: "t1",
        Name: "svc.1",
        Image: "img",
        Node: "n1",
        DesiredState: "Shutdown",
        CurrentState: "Failed 1 minute ago",
        Error: "task: non-zero exit (1)",
        Ports: "",
      };

      vi.spyOn(engine, "listServices").mockResolvedValueOnce([
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "updating" },
        },
        {
          ID: "svc2",
          Spec: { Name: "api" },
          UpdateStatus: { State: "updating" },
        },
      ] as ServiceWithMetadata[]);

      // Both services return stuck tasks
      vi.spyOn(engine, "listServiceTasks").mockResolvedValue([stuckTask]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValue([]);

      const promise = expect(monitorDeployment(settings)).rejects.toThrow(
        /failed: all tasks are in a failed state/,
      );
      await vi.runAllTimersAsync();
      await promise;

      // Both services should have had their tasks fetched
      expect(engine.listServiceTasks).toHaveBeenCalledWith("svc1");
      expect(engine.listServiceTasks).toHaveBeenCalledWith("svc2");
    });

    it("should build failure reports for all stuck services before throwing", async () => {
      vi.useFakeTimers();
      const core = await import("@actions/core");

      const stuckTask: TaskStatus = {
        ID: "t1",
        Name: "svc.1",
        Image: "img",
        Node: "n1",
        DesiredState: "Shutdown",
        CurrentState: "Failed 1 minute ago",
        Error: "No such image: img",
        Ports: "",
      };

      vi.spyOn(engine, "listServices").mockResolvedValueOnce([
        {
          ID: "svc1",
          Spec: { Name: "web" },
          UpdateStatus: { State: "updating" },
        },
        {
          ID: "svc2",
          Spec: { Name: "api" },
          UpdateStatus: { State: "updating" },
        },
      ] as ServiceWithMetadata[]);
      vi.spyOn(engine, "listServiceTasks").mockResolvedValue([stuckTask]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValue([]);

      const promise = expect(monitorDeployment(settings)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await promise;

      // Both services should have failure reports built
      expect(core.error).toHaveBeenCalledWith(expect.stringContaining('"web"'));
      expect(core.error).toHaveBeenCalledWith(expect.stringContaining('"api"'));
    });
  });
});
