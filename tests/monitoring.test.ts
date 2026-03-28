import { beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "../src/engine.js";
import type { ServiceWithMetadata, TaskStatus } from "../src/engine.js";
import {
  buildFailureReport,
  categorizeTaskError,
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
    vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce([
      { ID: "t1", Name: "test.1", Image: "img", Node: "n1", DesiredState: "Shutdown", CurrentState: "Failed 1 minute ago", Error: "task: non-zero exit (1)", Ports: "" },
    ]);
    vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([]);

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
    vi.spyOn(engine, "listServiceTasks").mockResolvedValueOnce([
      { ID: "t1", Name: "test.1", Image: "img", Node: "n1", DesiredState: "Shutdown", CurrentState: "Failed 1 minute ago", Error: "task: non-zero exit (1)", Ports: "" },
    ]);
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

  describe("buildFailureReport", () => {
    it("should produce a headline from the most recent failed task", async () => {
      const core = await import("@actions/core");
      const tasks: TaskStatus[] = [
        { ID: "t1", Name: "api.1", Image: "registry/api:v2", Node: "worker-1", DesiredState: "Shutdown", CurrentState: "Failed 2 minutes ago", Error: "task: non-zero exit (1)", Ports: "" },
        { ID: "t2", Name: "api.2", Image: "registry/api:v2", Node: "worker-2", DesiredState: "Shutdown", CurrentState: "Failed 1 minute ago", Error: "task: non-zero exit (1)", Ports: "" },
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
        { ID: "t1", Name: "api.1", Image: "img", Node: "worker-1", DesiredState: "Shutdown", CurrentState: "Failed 3 minutes ago", Error: "task: non-zero exit (1)", Ports: "" },
        { ID: "t2", Name: "api.2", Image: "img", Node: "worker-1", DesiredState: "Running", CurrentState: "Running 30 seconds ago", Error: "", Ports: "" },
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
        { ID: "t1", Name: "api.1", Image: "img", Node: "n1", DesiredState: "Shutdown", CurrentState: "Failed 1 minute ago", Error: "No such image: img", Ports: "" },
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
        { ID: "t1", Name: "api.1", Image: "img", Node: "n1", DesiredState: "Shutdown", CurrentState: "Failed 1 minute ago", Error: "task: non-zero exit (1)", Ports: "" },
      ]);
      vi.spyOn(engine, "getServiceLogs").mockResolvedValueOnce([
        { timestamp: new Date("2026-03-28T12:00:01Z"), metadata: {}, message: "Error: Cannot connect to database" },
        { timestamp: new Date("2026-03-28T12:00:02Z"), metadata: {}, message: "Shutting down..." },
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

  describe("categorizeTaskError", () => {
    it("should categorize image pull failures", () => {
      expect(categorizeTaskError("No such image: registry/app:v2")).toEqual({
        category: "image_pull",
        headline: 'Image could not be pulled: No such image: registry/app:v2',
      });
      expect(categorizeTaskError("manifest unknown")).toEqual({
        category: "image_pull",
        headline: "Image could not be pulled: manifest unknown",
      });
      expect(categorizeTaskError("pull access denied for registry/app")).toEqual({
        category: "image_pull",
        headline: "Image could not be pulled: pull access denied for registry/app",
      });
      expect(categorizeTaskError("unauthorized: authentication required")).toEqual({
        category: "image_pull",
        headline: "Image could not be pulled: unauthorized: authentication required",
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
      expect(categorizeTaskError("task: non-zero exit (127): exec not found")).toEqual({
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
      expect(categorizeTaskError("no suitable node (insufficient resources on 2 nodes)")).toEqual({
        category: "scheduling",
        headline: "No node available to run this task: no suitable node (insufficient resources on 2 nodes)",
      });
    });

    it("should categorize container startup failures", () => {
      expect(categorizeTaskError("starting container failed: OCI runtime create failed")).toEqual({
        category: "startup_failure",
        headline: "Container failed to start: starting container failed: OCI runtime create failed",
      });
    });

    it("should categorize network errors", () => {
      expect(categorizeTaskError("failed to allocate network IP for task")).toEqual({
        category: "network",
        headline: "Network allocation failed: failed to allocate network IP for task",
      });
    });

    it("should categorize volume errors", () => {
      expect(categorizeTaskError("invalid bind mount source, source path not found: /data")).toEqual({
        category: "volume",
        headline: "Volume or mount failed: invalid bind mount source, source path not found: /data",
      });
    });

    it("should categorize secret/config errors", () => {
      expect(categorizeTaskError("secret reference my_secret not found")).toEqual({
        category: "config",
        headline: "Secret or config reference invalid: secret reference my_secret not found",
      });
    });

    it("should categorize dependency errors", () => {
      expect(categorizeTaskError("dependency not ready")).toEqual({
        category: "dependency",
        headline: "Task dependencies not yet available",
      });
    });

    it("should categorize entrypoint errors", () => {
      expect(categorizeTaskError("OCI runtime create failed: exec format error")).toEqual({
        category: "entrypoint",
        headline: "Container entrypoint failed: OCI runtime create failed: exec format error",
      });
    });

    it("should categorize port conflicts", () => {
      expect(categorizeTaskError("host-mode port already in use on 1 node")).toEqual({
        category: "port_conflict",
        headline: "Host port already in use: host-mode port already in use on 1 node",
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
});
