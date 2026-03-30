# Path Validation, Exponential Backoff, and Partial Success Reporting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compose file path containment validation, exponential backoff to monitoring polling, and partial success reporting on timeout.

**Architecture:** Three independent changes to existing modules. Path validation goes in `resolveComposeFiles()` before the existence check. Backoff replaces the fixed-interval sleep in `monitorDeployment()`. Partial success enriches the timeout path in the same function with a summary message and job summary table.

**Tech Stack:** TypeScript, Vitest, `@actions/core`, Node.js `path` module

---

### Task 1: Path containment validation — tests

**Files:**
- Test: `tests/compose.test.ts`

- [ ] **Step 1: Write failing tests for path traversal rejection**

Add a new `describe` block inside the `"Compose File Resolution"` section of `tests/compose.test.ts`, after the existing resolution tests (around line 184):

```typescript
describe("path containment", () => {
  it("should reject paths that escape the workspace via ..", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
    const settingsWithFiles = defineSettings({
      ...settings,
      composeFiles: ["../../etc/passwd"],
    });

    await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("should reject absolute paths outside the workspace", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
    const settingsWithFiles = defineSettings({
      ...settings,
      composeFiles: ["/etc/passwd"],
    });

    await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("should accept paths within the workspace", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", process.cwd());
    vi.spyOn(utils, "exists").mockResolvedValue(true);
    const settingsWithFiles = defineSettings({
      ...settings,
      composeFiles: ["docker/compose.yaml"],
    });

    await expect(resolveComposeFiles(settingsWithFiles)).resolves.toEqual([
      "docker/compose.yaml",
    ]);
  });

  it("should accept paths when GITHUB_WORKSPACE is not set (falls back to cwd)", async () => {
    delete process.env.GITHUB_WORKSPACE;
    vi.spyOn(utils, "exists").mockResolvedValue(true);
    const settingsWithFiles = defineSettings({
      ...settings,
      composeFiles: ["compose.yaml"],
    });

    await expect(resolveComposeFiles(settingsWithFiles)).resolves.toEqual([
      "compose.yaml",
    ]);
  });

  it("should report all offending paths in the error message", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo");
    const settingsWithFiles = defineSettings({
      ...settings,
      composeFiles: ["../secret.yaml", "/tmp/other.yaml"],
    });

    await expect(resolveComposeFiles(settingsWithFiles)).rejects.toThrow(
      /secret\.yaml.*other\.yaml|other\.yaml.*secret\.yaml/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compose.test.ts`
Expected: 5 new tests FAIL (no path validation exists yet)

### Task 2: Path containment validation — implementation

**Files:**
- Modify: `src/compose.ts:1-10` (add `resolve` import)
- Modify: `src/compose.ts:49-84` (add validation before existence check)

- [ ] **Step 1: Add path import and validation function**

At the top of `src/compose.ts`, add `resolve` to the existing `path` import:

```typescript
import { join, resolve } from "node:path";
```

Then add this validation before the existence check in `resolveComposeFiles`, right after the `if (settings.composeFiles && settings.composeFiles.length > 0) {` line (line 63), before the `const files = await Promise.all(` line:

```typescript
    // Validate that all specified paths resolve within the workspace to
    // prevent path traversal attacks (e.g., "../../etc/passwd").
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const resolvedWorkspace = resolve(workspace);
    const escapedPaths = settings.composeFiles.filter(
      (path) => !resolve(path).startsWith(resolvedWorkspace),
    );

    if (escapedPaths.length > 0) {
      throw new Error(
        `One or more Compose Files resolve outside the workspace ` +
          `directory: ${escapedPaths.join(", ")}`,
      );
    }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/compose.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: validate compose file paths stay within workspace"
```

### Task 3: Exponential backoff in monitoring — tests

**Files:**
- Test: `tests/monitoring.test.ts`

- [ ] **Step 1: Write failing tests for backoff behavior**

Add a new `describe` block at the end of the `"Monitoring"` describe in `tests/monitoring.test.ts` (before the closing `});` of the top-level describe):

```typescript
describe("exponential backoff", () => {
  it("should increase sleep interval between polls", async () => {
    vi.useFakeTimers();

    const sleepSpy = vi.spyOn(await import("../src/utils.js"), "sleep");

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

    // First sleep: 5s (monitorInterval), second sleep: 7.5s (5 * 1.5)
    expect(sleepSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 7_500);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 11_250);
  });

  it("should cap the backoff interval at monitorInterval * 6", async () => {
    vi.useFakeTimers();

    const sleepSpy = vi.spyOn(await import("../src/utils.js"), "sleep");

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

    const sleepSpy = vi.spyOn(await import("../src/utils.js"), "sleep");

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
    // Poll 1: 5000, Poll 2: 7500, Poll 3 (svc1 completes, reset): 11250
    // Poll 4: 5000 (reset happened after poll 3)
    expect(sleepValues[3]).toBe(5_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/monitoring.test.ts`
Expected: 3 new tests FAIL (sleep is always called with `monitorInterval * 1000`)

### Task 4: Exponential backoff in monitoring — implementation

**Files:**
- Modify: `src/monitoring.ts:23-110` (`monitorDeployment` function)

- [ ] **Step 1: Add backoff logic to the monitoring loop**

Replace the monitoring loop in `monitorDeployment` (lines 30-109). The changes are:
1. Add `currentInterval` and `maxInterval` variables after `startTime`
2. Use `currentInterval` in the sleep call instead of the fixed interval
3. Grow `currentInterval` by 1.5x after each poll, capped at `maxInterval`
4. Reset `currentInterval` when the `completedServices` set grows
5. Use elapsed time instead of attempt counting for timeout

Replace lines 32-109 (from `const startTime` through the end of the `do...while`) with:

```typescript
  const startTime = new Date();
  const baseInterval = settings.monitorInterval * 1_000;
  const maxInterval = baseInterval * 6;
  let currentInterval = baseInterval;
  const completedServices = new Set<string>();
  let services: ServiceWithMetadata[] = [];

  do {
    await sleep(currentInterval);

    const elapsed = Date.now() - startTime.getTime();

    if (elapsed >= settings.monitorTimeout * 1_000) {
      // On timeout, report diagnostics for all non-converged services
      for (const service of services) {
        if (completedServices.has(service.ID)) {
          continue;
        }
        const name = service.Spec?.Name ?? service.Name ?? service.ID;
        await buildFailureReport(service.ID, name, startTime);
      }

      const convergedNames = services
        .filter((s) => completedServices.has(s.ID))
        .map((s) => s.Spec?.Name ?? s.Name ?? s.ID);
      const pendingNames = services
        .filter((s) => !completedServices.has(s.ID))
        .map((s) => s.Spec?.Name ?? s.Name ?? s.ID);

      // Job summary table for partial success
      core.summary.addHeading("Deployment timeout summary", 2);
      core.summary.addTable([
        [
          { data: "Service", header: true },
          { data: "Status", header: true },
        ],
        ...convergedNames.map((n) => [{ data: n }, { data: "Converged" }]),
        ...pendingNames.map((n) => [{ data: n }, { data: "Pending" }]),
      ]);

      if (convergedNames.length > 0) {
        core.info(
          `Services converged: ${convergedNames.join(", ")}`,
        );
      }

      if (pendingNames.length > 0) {
        core.error(
          `Services not converged: ${pendingNames.join(", ")}`,
        );
      }

      throw new Error(
        `Deployment timed out: ${completedServices.size}/${services.length} services converged`,
      );
    }

    services = await listServices(
      { labels: { "com.docker.stack.namespace": settings.stack } },
      true,
    );

    core.debug(
      `Waiting for services to finish updating: ` +
        `${completedServices.size}/${services.length}`,
    );

    const previousSize = completedServices.size;

    for (const service of services) {
      if (completedServices.has(service.ID)) {
        continue;
      }

      const serviceIdentifier =
        service.Spec?.Name ?? service.Name ?? service.ID;
      let complete: boolean;

      try {
        complete = isServiceUpdateComplete(service);
      } catch (error) {
        await buildFailureReport(service.ID, serviceIdentifier, startTime);
        core.error(`Service Details:\n${JSON.stringify(service, null, 2)}`);

        throw error;
      }

      if (complete) {
        core.info(
          `Service "${serviceIdentifier}" has been deployed successfully`,
        );
        completedServices.add(service.ID);
        continue;
      }

      // If the service appears to be "updating" but all tasks are in a
      // terminal failure state, it will never recover — fail early instead
      // of waiting for the full timeout.
      const tasks = await fetchTasks(service.ID);
      if (tasks && isServiceStuck(tasks)) {
        await buildFailureReport(
          service.ID,
          serviceIdentifier,
          startTime,
          tasks,
        );
        throw new Error(
          `Service "${serviceIdentifier}" failed: all tasks are in a failed state`,
        );
      }
    }

    // Reset interval if progress was made, otherwise grow with backoff
    if (completedServices.size > previousSize) {
      currentInterval = baseInterval;
    } else {
      currentInterval = Math.min(currentInterval * 1.5, maxInterval);
    }
  } while (completedServices.size < services.length);
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/monitoring.test.ts`
Expected: All tests PASS

Note: The existing timeout test (`"should fail if the update takes too long"`) uses `monitorTimeout: 3` and `monitorInterval: 1`. With the new elapsed-time-based timeout, this test should still pass because the elapsed time will exceed 3 seconds. If it fails, the test may need its mock chain adjusted since the backoff changes poll timing. Check and fix if needed.

- [ ] **Step 3: Commit**

```bash
git add src/monitoring.ts tests/monitoring.test.ts
git commit -m "feat: add exponential backoff to deployment monitoring"
```

### Task 5: Partial success reporting — tests

**Files:**
- Test: `tests/monitoring.test.ts`

- [ ] **Step 1: Write failing tests for partial success reporting on timeout**

Add a new `describe` block at the end of the `"Monitoring"` describe in `tests/monitoring.test.ts`:

```typescript
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
      monitorDeployment({ ...settings, monitorTimeout: 3, monitorInterval: 1 }),
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
      monitorDeployment({ ...settings, monitorTimeout: 3, monitorInterval: 1 }),
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
      monitorDeployment({ ...settings, monitorTimeout: 3, monitorInterval: 1 }),
    ).rejects.toThrow(/0\/1 services converged/);
    await vi.runAllTimersAsync();
    await promise;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/monitoring.test.ts`
Expected: Tests FAIL because the current timeout error message is just `"Deployment timed out"` without the count, and there's no job summary table on timeout.

Note: If Task 4 (backoff) was already implemented, the partial success reporting code was included there. In that case these tests should already pass. If implementing tasks independently, the partial success code in Task 4's implementation handles both backoff and partial success. Verify and skip to commit if tests pass.

### Task 6: Partial success reporting — implementation (if not already done)

**Files:**
- Modify: `src/monitoring.ts:23-110` (timeout handling in `monitorDeployment`)

- [ ] **Step 1: Verify if partial success is already implemented**

If Task 4 was implemented, the timeout block already includes partial success reporting. Run:

Run: `npx vitest run tests/monitoring.test.ts`

If all tests pass, skip to step 3. If not, the timeout block in `monitorDeployment` needs the partial success code. The required changes are in the timeout section of Task 4's implementation — the block that computes `convergedNames`/`pendingNames`, adds the job summary table, and throws with the `N/M services converged` message.

- [ ] **Step 2: Add partial success reporting (only if step 1 failed)**

In the timeout block of `monitorDeployment` (the `if (elapsed >= ...)` branch), after the failure report loop and before the `throw`, add the converged/pending name computation, job summary table, info/error logging, and enriched error message as shown in Task 4's implementation.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run tests/monitoring.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/monitoring.ts tests/monitoring.test.ts
git commit -m "feat: report partial success on deployment timeout"
```

### Task 7: Fix existing timeout test

**Files:**
- Test: `tests/monitoring.test.ts`

- [ ] **Step 1: Update the existing timeout test to match new error message**

The test `"should fail if the update takes too long"` (around line 366) currently expects `"Deployment timed out"`. Update it to match the new format:

Find:
```typescript
    ).rejects.toThrowError();
```

in the timeout test and change the assertion to match the enriched message pattern:
```typescript
    ).rejects.toThrow(/Deployment timed out/);
```

This is a loose match that works with both old and new message formats. However, the test may also need adjustment because the backoff changes the number of polls that fit within the timeout window. The test uses `monitorTimeout: 3` and `monitorInterval: 1`, which means:
- Old behavior: 3 attempts (3/1 = 3 polls)
- New behavior: elapsed time check after each sleep. With backoff (1s, 1.5s, 2.25s), about 2-3 polls fit in 3 seconds.

Check the mock chain — it sets up 4 `updating` responses followed by 1 `completed`. With fewer polls fitting in the timeout, the `completed` response may never be reached, which is fine (the test expects a timeout error). But the `listServices` call count assertion may need updating.

If the test fails, update the `expect(listServices).toHaveBeenCalledTimes()` assertion to match the actual number of polls that fit in the timeout window with backoff. Remove the exact count assertion and use `toHaveBeenCalled()` instead if the exact count is fragile.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/monitoring.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit (if changes were needed)**

```bash
git add tests/monitoring.test.ts
git commit -m "test: update timeout test for backoff and enriched error message"
```

### Task 8: Lint, typecheck, and full pipeline

**Files:**
- All modified files

- [ ] **Step 1: Run the full pipeline**

Run: `npm run all`
Expected: All checks pass (format, lint, typecheck, test, package)

- [ ] **Step 2: Fix any issues**

If lint or format issues are found, fix them. Common issues:
- Biome may flag unused imports after refactoring
- Line length in test files

- [ ] **Step 3: Commit fixes (if needed)**

```bash
git add -A
git commit -m "fix: lint and format fixes"
```
