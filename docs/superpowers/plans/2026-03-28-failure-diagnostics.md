# Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface actionable root-cause errors when a Docker Swarm deployment fails, replacing the current opaque "rolled back" messages.

**Architecture:** Add `listServiceTasks()` to `engine.ts` to fetch task-level state via `docker service ps`. Add `categorizeTaskError()` pure function and `buildFailureReport()` orchestrator to `monitoring.ts`. Replace the existing catch block in `monitorDeployment` with the structured report.

**Tech Stack:** TypeScript, Docker CLI (`docker service ps`), `@actions/core` for output/summary, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-28-failure-diagnostics-design.md`

---

### Task 1: Add `listServiceTasks` to engine

**Files:**
- Modify: `src/engine.ts` (add function + type, near line 180 before `getServiceLogs`)
- Test: `tests/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/engine.test.ts` inside the main `describe("engine")` block, after the `getServiceLogs` describe:

```ts
describe("listServiceTasks", () => {
  it("should list tasks for a service and parse JSON", async () => {
    const mockTask = {
      ID: "task1",
      Name: "api.1",
      Image: "registry/api:v2",
      Node: "worker-1",
      DesiredState: "Shutdown",
      CurrentState: "Failed 2 minutes ago",
      Error: "task: non-zero exit (1)",
      Ports: "",
    };
    mockedExec.mockImplementation(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(`${JSON.stringify(mockTask)}\n`));
      return 0;
    });

    const tasks = await engine.listServiceTasks("svc1");

    expect(mockedExec).toHaveBeenCalledWith(
      "docker",
      ["service", "ps", "--format=json", "--no-trunc", "svc1"],
      expect.any(Object),
    );
    expect(tasks).toEqual([mockTask]);
  });

  it("should return multiple tasks in order", async () => {
    const task1 = { ID: "t1", Name: "api.1", Image: "img", Node: "n1", DesiredState: "Shutdown", CurrentState: "Failed 3 minutes ago", Error: "task: non-zero exit (1)", Ports: "" };
    const task2 = { ID: "t2", Name: "api.2", Image: "img", Node: "n2", DesiredState: "Running", CurrentState: "Running 1 minute ago", Error: "", Ports: "" };
    mockedExec.mockImplementation(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(`${JSON.stringify(task1)}\n${JSON.stringify(task2)}\n`));
      return 0;
    });

    const tasks = await engine.listServiceTasks("svc1");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].ID).toBe("t1");
    expect(tasks[1].ID).toBe("t2");
  });

  it("should throw error on exec failure", async () => {
    mockedExec.mockRejectedValue(new Error("Docker error"));
    await expect(engine.listServiceTasks("svc1")).rejects.toThrowError(
      /Failed to list tasks/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run tests/engine.test.ts`
Expected: FAIL — `listServiceTasks` is not a function

- [ ] **Step 3: Write implementation**

Add to `src/engine.ts` before `getServiceLogs`:

```ts
export type TaskStatus = {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
  Ports: string;
};

export async function listServiceTasks(serviceId: string): Promise<TaskStatus[]> {
  try {
    const output = await executeDockerCommand(
      ["service", "ps", "--format=json", "--no-trunc", serviceId],
      { silent: true },
    );

    return parseLineDelimitedJson<TaskStatus>(output);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to list tasks for service "${serviceId}": ${message}`, { cause });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run tests/engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/engine.test.ts
git commit -m "feat: add listServiceTasks to fetch task-level state"
```

---

### Task 2: Add `categorizeTaskError` pure function

**Files:**
- Modify: `src/monitoring.ts` (add exported function at bottom)
- Test: `tests/monitoring.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/monitoring.test.ts`. First, add `categorizeTaskError` to the import:

```ts
import {
  categorizeTaskError,
  isServiceRunning,
  isServiceUpdateComplete,
  monitorDeployment,
} from "../src/monitoring.js";
```

Then add a new describe block after the existing `describe("edge cases and error handling")`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run tests/monitoring.test.ts`
Expected: FAIL — `categorizeTaskError` is not exported

- [ ] **Step 3: Write implementation**

Add to the bottom of `src/monitoring.ts`, before the closing of the file:

```ts
export type ErrorCategory =
  | "image_pull"
  | "oom_kill"
  | "container_crash"
  | "health_check"
  | "scheduling"
  | "startup_failure"
  | "network"
  | "volume"
  | "config"
  | "dependency"
  | "entrypoint"
  | "port_conflict"
  | "unknown";

export function categorizeTaskError(error: string): {
  category: ErrorCategory;
  headline: string;
} {
  if (!error) {
    return { category: "unknown", headline: "Unknown error" };
  }

  const patterns: Array<{
    test: (e: string) => boolean;
    category: ErrorCategory;
    headline: (e: string) => string;
  }> = [
    {
      test: (e) => /No such image|manifest unknown|manifest not found|pull access denied|unauthorized/.test(e),
      category: "image_pull",
      headline: (e) => `Image could not be pulled: ${e}`,
    },
    {
      test: (e) => /non-zero exit \(137\)/.test(e),
      category: "oom_kill",
      headline: () => "Container killed (likely OOM): exit code 137",
    },
    {
      test: (e) => /non-zero exit \((\d+)\)/.test(e),
      category: "container_crash",
      headline: (e) => {
        const code = e.match(/non-zero exit \((\d+)\)/)?.[1] ?? "?";
        return `Container exited with code ${code}`;
      },
    },
    {
      test: (e) => /unhealthy container/.test(e),
      category: "health_check",
      headline: () => "Container failed health check",
    },
    {
      test: (e) => /no suitable node/.test(e),
      category: "scheduling",
      headline: (e) => `No node available to run this task: ${e}`,
    },
    {
      test: (e) => /starting container failed|OCI runtime create failed/.test(e) && !/exec format error|permission denied|no such file or directory/.test(e),
      category: "startup_failure",
      headline: (e) => `Container failed to start: ${e}`,
    },
    {
      test: (e) => /exec format error|(?:^|\W)permission denied|no such file or directory/.test(e),
      category: "entrypoint",
      headline: (e) => `Container entrypoint failed: ${e}`,
    },
    {
      test: (e) => /failed to allocate network IP|Address already in use|missing network attachments/.test(e),
      category: "network",
      headline: (e) => `Network allocation failed: ${e}`,
    },
    {
      test: (e) => /invalid bind mount source|no space left on device/.test(e),
      category: "volume",
      headline: (e) => `Volume or mount failed: ${e}`,
    },
    {
      test: (e) => /secret reference|config reference|not found/.test(e),
      category: "config",
      headline: (e) => `Secret or config reference invalid: ${e}`,
    },
    {
      test: (e) => /dependency not ready/.test(e),
      category: "dependency",
      headline: () => "Task dependencies not yet available",
    },
    {
      test: (e) => /host-mode port already in use/.test(e),
      category: "port_conflict",
      headline: (e) => `Host port already in use: ${e}`,
    },
  ];

  for (const pattern of patterns) {
    if (pattern.test(error)) {
      return {
        category: pattern.category,
        headline: pattern.headline(error),
      };
    }
  }

  return { category: "unknown", headline: error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run tests/monitoring.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring.ts tests/monitoring.test.ts
git commit -m "feat: add categorizeTaskError for failure classification"
```

---

### Task 3: Add `buildFailureReport` and wire it into monitoring

**Files:**
- Modify: `src/monitoring.ts` (add function, replace catch block)
- Test: `tests/monitoring.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/monitoring.test.ts`. First, update the import from engine to include `listServiceTasks` and `TaskStatus`:

```ts
import {
  getServiceLogs,
  listServices,
  listServiceTasks,
  type Service,
  type ServiceWithMetadata,
  type TaskStatus,
} from "../src/engine.js";
```

Add `buildFailureReport` to the monitoring import:

```ts
import {
  buildFailureReport,
  categorizeTaskError,
  isServiceRunning,
  isServiceUpdateComplete,
  monitorDeployment,
} from "../src/monitoring.js";
```

Then add the describe block:

```ts
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

    // Should log task history
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run tests/monitoring.test.ts`
Expected: FAIL — `buildFailureReport` is not exported

- [ ] **Step 3: Write implementation**

Add `buildFailureReport` to `src/monitoring.ts`. First, update the imports at the top of the file:

```ts
import * as core from "@actions/core";
import {
  getServiceLogs,
  listServices,
  listServiceTasks,
  type Service,
  type ServiceWithMetadata,
  type TaskStatus,
} from "./engine.js";
import type { Settings } from "./settings.js";
import { sleep } from "./utils.js";
```

Then add the function after `resolveFailureReason` and before `categorizeTaskError`:

```ts
/**
 * Build a structured diagnostic report for a failed service update.
 *
 * Fetches task-level state and container logs, then outputs a report
 * prioritized for actionability: root cause first, then timeline, then
 * supplementary context.
 */
export async function buildFailureReport(
  serviceId: string,
  serviceName: string,
  startTime: Date,
) {
  // 1. Fetch task-level state
  let tasks: TaskStatus[];

  try {
    tasks = await listServiceTasks(serviceId);
  } catch {
    core.error(`Failed to fetch task details for service "${serviceName}"`);
    return;
  }

  if (tasks.length === 0) {
    core.error(`No task information available for service "${serviceName}"`);
    return;
  }

  // 2. Find the most recent failed task and produce a headline
  const failedTasks = tasks.filter(
    (t) => t.Error && t.DesiredState !== "Running",
  );
  const latestFailedTask = failedTasks[0];

  if (latestFailedTask) {
    const { headline } = categorizeTaskError(latestFailedTask.Error);
    core.error(`Service "${serviceName}" failed to deploy: ${headline}`);
  } else {
    core.error(`Service "${serviceName}" failed to deploy (no task error details available)`);
  }

  // 3. Task attempt history
  const history = tasks
    .map((t) => {
      const error = t.Error ? ` "${t.Error}"` : "";
      return `  ${t.Name}  ${t.DesiredState.padEnd(10)}  ${t.CurrentState}${error}  (node: ${t.Node})`;
    })
    .join("\n");

  core.error(`Task history for service "${serviceName}":\n${history}`);

  // 4. Container logs
  let logs: Awaited<ReturnType<typeof getServiceLogs>>;

  try {
    logs = await getServiceLogs(serviceId, { since: startTime, tail: 50 });
  } catch {
    core.warning(`Failed to fetch container logs for service "${serviceName}"`);
    logs = [];
  }

  if (logs.length === 0) {
    core.error(
      `No container logs available for service "${serviceName}" (container may not have started)`,
    );
  } else {
    const logLines = logs
      .map((entry) => {
        const ts = entry.timestamp?.toISOString() ?? "<no timestamp>";
        return `  ${ts}  ${entry.message}`;
      })
      .join("\n");

    core.error(`Container logs for service "${serviceName}":\n${logLines}`);
  }

  // 5. Write to job summary
  core.summary.addHeading(`Deployment failure: ${serviceName}`, 2);

  if (latestFailedTask) {
    const { headline } = categorizeTaskError(latestFailedTask.Error);
    core.summary.addRaw(`**Root cause:** ${headline}`, true);
  }

  core.summary.addHeading("Task history", 3);
  core.summary.addTable([
    [
      { data: "Task", header: true },
      { data: "State", header: true },
      { data: "Current State", header: true },
      { data: "Error", header: true },
      { data: "Node", header: true },
    ],
    ...tasks.map((t) => [
      { data: t.Name },
      { data: t.DesiredState },
      { data: t.CurrentState },
      { data: t.Error || "-" },
      { data: t.Node },
    ]),
  ]);

  if (logs.length > 0) {
    core.summary.addHeading("Container logs", 3);
    core.summary.addCodeBlock(
      logs
        .map((entry) => {
          const ts = entry.timestamp?.toISOString() ?? "<no timestamp>";
          return `${ts}  ${entry.message}`;
        })
        .join("\n"),
    );
  } else {
    core.summary.addRaw(
      "_No container logs available (container may not have started)_",
      true,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run tests/monitoring.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring.ts tests/monitoring.test.ts
git commit -m "feat: add buildFailureReport for structured failure diagnostics"
```

---

### Task 4: Wire `buildFailureReport` into `monitorDeployment` and update existing tests

**Files:**
- Modify: `src/monitoring.ts` (replace catch block in `monitorDeployment`)
- Modify: `tests/monitoring.test.ts` (update failure tests to mock `listServiceTasks`)

- [ ] **Step 1: Replace the catch block in `monitorDeployment`**

In `src/monitoring.ts`, replace the catch block (lines 65-103) inside the `for (const service of services)` loop:

Replace this:
```ts
      } catch (error) {
        const logs = await getServiceLogs(service.ID, { since: startTime });
        const message = error instanceof Error ? error.message : String(error);

        core.error(
          new Error(
            `Service "${serviceIdentifier}" failed to update: ${message}`,
            { cause: error },
          ),
        );
        core.error(`Service Details:\n${JSON.stringify(service, null, 2)}`);
        core.setOutput("service-logs", logs.toString());
        core.summary.addHeading("Service Logs", 2);
        core.summary.addRaw(
          `Before the "${serviceIdentifier}" service update failed, the following logs were generated:`,
          true,
        );
        core.summary.addTable([
          [
            { data: "timestamp", header: true },
            { data: "message", header: true },
            ...(logs[0]
              ? Object.keys(logs[0].metadata).map((key) => ({
                  data: key,
                  header: true,
                }))
              : []),
          ],
          ...logs.map((entry) => [
            { data: entry.timestamp?.toISOString() ?? "<no timestamp>" },
            { data: entry.message },
            ...(entry.metadata
              ? Object.values(entry.metadata).map((value) => ({ data: value }))
              : []),
          ]),
        ]);

        throw error;
      }
```

With this:
```ts
      } catch (error) {
        await buildFailureReport(service.ID, serviceIdentifier, startTime);
        core.error(`Service Details:\n${JSON.stringify(service, null, 2)}`);

        throw error;
      }
```

- [ ] **Step 2: Update the "should fail if a service is rolled back" test**

The test at line 296 now needs `listServiceTasks` mocked since `buildFailureReport` calls it. Add the mock to the test:

```ts
it("should fail if a service is rolled back", async () => {
  vi.useFakeTimers();

  const serviceHistory = [
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "updating" } } as ServiceWithMetadata],
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "updating" } } as ServiceWithMetadata],
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "rollback_started" } } as ServiceWithMetadata],
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

  const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
  await vi.runAllTimersAsync();
  await promise;

  expect(listServices).toHaveBeenCalledTimes(serviceHistory.length);
});
```

- [ ] **Step 3: Update the "should print the service logs on failure" test**

Replace the test at line 377:

```ts
it("should print the service logs on failure", async () => {
  vi.useFakeTimers();
  const core = await import("@actions/core");

  const serviceHistory = [
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "updating" } } as ServiceWithMetadata],
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "updating" } } as ServiceWithMetadata],
    [{ ID: "web_service", Spec: { Name: "test" }, UpdateStatus: { State: "rollback_started" } } as ServiceWithMetadata],
  ];
  const listServicesSpy = vi
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
      metadata: {},
    },
  ]);

  const promise = expect(monitorDeployment(settings)).rejects.toThrowError();
  await vi.runAllTimersAsync();
  await promise;

  expect(listServicesSpy).toHaveBeenCalledTimes(serviceHistory.length);
  expect(engine.getServiceLogs).toHaveBeenCalledWith(
    "web_service",
    expect.objectContaining({ since: expect.any(Date), tail: 50 }),
  );
  expect(core.error).toHaveBeenCalledWith(
    expect.stringContaining("Error occurred during service update"),
  );
});
```

- [ ] **Step 4: Run all tests to verify everything passes**

Run: `npx vitest --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring.ts tests/monitoring.test.ts
git commit -m "feat: wire buildFailureReport into monitorDeployment"
```

---

### Task 5: Remove unused import and verify full pipeline

**Files:**
- Modify: `src/monitoring.ts` (clean up unused import if `getServiceLogs` is no longer directly imported)

- [ ] **Step 1: Check for unused imports**

`getServiceLogs` is now only called inside `buildFailureReport`, which imports it from engine. Verify the import in `monitoring.ts` — `getServiceLogs` should still be in the import since `buildFailureReport` is in the same file and uses it.

No change needed if the import is still used.

- [ ] **Step 2: Run the full pipeline**

Run: `npm run all`
Expected: format, lint, typecheck, test, coverage, package all pass.

- [ ] **Step 3: Commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: clean up after failure diagnostics implementation"
```
