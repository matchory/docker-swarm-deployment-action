# Failure Diagnostics for Deployment Monitoring

## Problem

When a deployment fails, the action produces opaque error messages like:

```
Error: Service "api" failed to update: Service failed to update and was rolled back: rollback completed
```

The actual failure reason (bad image, crash, health check, etc.) is only available by SSHing into the server and running `docker service ps <service> --no-trunc`. Service logs included in the output are always empty because the container often never ran long enough to produce any.

## Solution

When a service update fails during monitoring, build a structured diagnostic report that surfaces the root cause prominently, shows the task attempt timeline, and includes container logs when available.

## Data Source

The missing data is **task-level state**, available via `docker service ps <id> --format=json --no-trunc`. Each task object contains:
- `ID`, `Name`, `Image`, `Node`
- `DesiredState` (running, shutdown)
- `CurrentState` (e.g., "Failed 2 minutes ago")
- `Error` — the actual failure reason string

This is not currently fetched anywhere in the action.

## Changes

### 1. New engine function: `listServiceTasks`

Add to `engine.ts`. Calls `docker service ps <service-id> --format=json --no-trunc` and returns typed task objects.

Type:
```ts
type TaskStatus = {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
  Ports: string;
};
```

### 2. Failure categorization

A pure function: task error string in, category + human-readable headline out. Uses substring matching, always falls back to the raw error verbatim.

| Error pattern | Category | Headline |
|---|---|---|
| `No such image` / `manifest unknown` / `pull access denied` / `unauthorized` | image_pull | `Image "<image>" could not be pulled` |
| `non-zero exit (137)` | oom_kill | `Container killed (likely OOM): exit code 137` |
| `non-zero exit (N)` | container_crash | `Container exited with code N` |
| `unhealthy container` | health_check | `Container failed health check` |
| `no suitable node` | scheduling | `No node available to run this task` |
| `starting container failed` / `OCI runtime create failed` | startup_failure | `Container failed to start` |
| `failed to allocate network IP` / `Address already in use` / `missing network attachments` | network | `Network allocation failed` |
| `invalid bind mount source` / `no space left on device` | volume | `Volume or mount failed` |
| `secret reference` / `config reference` / `not found` (config context) | config | `Secret or config reference invalid` |
| `dependency not ready` | dependency | `Task dependencies not yet available` |
| `exec format error` / `permission denied` / `no such file or directory` (OCI context) | entrypoint | `Container entrypoint failed` |
| `host-mode port already in use` | port_conflict | `Host port already in use` |
| *(anything else)* | unknown | Raw error string verbatim |

Note: `non-zero exit (137)` is checked before the general `non-zero exit` pattern since 137 = SIGKILL, commonly OOM.

### 3. Diagnostic report structure

Replace the failure handling in `monitorDeployment`'s catch block with a structured report:

**Priority 1 — Headline error** (via `core.error`):
```
Service "api" failed to deploy: Container exited with code 1
```
The categorized error from the most recent failed task.

**Priority 2 — Task attempt history** (via `core.error`):
```
Task history for service "api":
  #1  Failed    2m ago   "task: non-zero exit (1)"    (node: worker-1)
  #2  Failed    1m ago   "task: non-zero exit (1)"    (node: worker-2)
  #3  Shutdown  30s ago  rollback                     (node: worker-1)
```

**Priority 3 — Container logs** (via `core.error`):
Last 50 lines from `getServiceLogs`. If empty, explicitly state:
`No container logs available (container may not have started)`

**Priority 4 — Service inspect** (supplementary):
The existing JSON service details, kept at the end as context.

All of this also goes into `core.summary` with markdown formatting for the GitHub Actions job summary page.

### 4. Files changed

- **`engine.ts`** — Add `listServiceTasks()` function
- **`monitoring.ts`** — Replace failure catch block with `buildFailureReport()` that orchestrates the diagnostic output; add `categorizeTaskError()` pure function
- **Tests** — New tests for `listServiceTasks`, `categorizeTaskError`, and `buildFailureReport`; update existing monitoring tests for new error format

### 5. Not in scope

- Changes to the action's public interface (inputs/outputs)
- Failure detection when `monitor: false` (deploy with `--detach=true` returns before convergence)
- Retry logic or automatic remediation
