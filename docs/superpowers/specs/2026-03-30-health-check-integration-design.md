# Health Check Integration

## Summary

Surface health check configuration in failure diagnostics and validate
health check definitions during compose processing. Gives users
actionable context when deployments fail due to health check issues,
and catches common misconfigurations before deploy.

## 1. Health check config in failure reports

When a task error is categorized as `health_check` by
`categorizeTaskError`, include the service's health check
configuration in the failure report.

**Data flow:** The compose spec (post-interpolation) is passed through
the deployment chain so `buildFailureReport` can extract health check
config for the failing service. Rather than passing the full spec,
`monitorDeployment` receives the spec, looks up the service name in
`spec.services`, and passes the `healthcheck` object to
`buildFailureReport` as an optional parameter.

**Output format** (both `core.error()` and job summary):

```
Health check configuration for service "api":
  Test:         CMD-SHELL curl -f http://localhost:8080/health
  Interval:     30s
  Timeout:      10s
  Retries:      3
  Start period: 60s
```

In the job summary, this appears as a key-value table between the
root cause headline and the task history table.

**Condition:** Only shown when the error category is `health_check`.

## 2. Missing health check warnings

After interpolation and before deploy, iterate all services in the
final compose spec. Emit `core.warning()` for any service that:

- Has no `healthcheck` key at all
- Has `healthcheck.test` set to `["NONE"]` or `"NONE"`

Warning format:
```
Service "worker" has no health check defined
```

## 3. Suspect configuration heuristics

Same phase as missing health check warnings. Emit `core.warning()`
when:

- **interval < timeout**: "Health check interval (5s) is shorter than
  timeout (30s) for service 'api'"
- **retries is 1**: "Health check for service 'api' has only 1 retry;
  a single failure will mark the container unhealthy"
- **start_period is 0/unset with interval < 10s**: "Service 'api' has
  no start period with a short health check interval (5s); container
  may fail checks before it is ready"

## 4. Suppression

New boolean input `health-check-warnings` (default: `true`). When set
to `false`, suppresses all warnings from sections 2 and 3. Does NOT
suppress health check config in failure reports (section 1) -- that is
always shown when relevant.

## 5. Files to change

| File | Change |
|------|--------|
| `action.yml` | Add `health-check-warnings` input |
| `src/settings.ts` | Parse new input into settings |
| `src/healthcheck.ts` | New module: `validateHealthChecks()` and `formatHealthCheck()` |
| `src/deployment.ts` | Call `validateHealthChecks()` after interpolation; pass spec to `monitorDeployment()` |
| `src/monitoring.ts` | Accept spec in `monitorDeployment()`; pass healthcheck to `buildFailureReport()` |
| `tests/healthcheck.test.ts` | Tests for validation and formatting |
| `tests/monitoring.test.ts` | Tests for healthcheck display in failure reports |
| `tests/deployment.test.ts` | Tests for validation being called |

## 6. Compose spec healthcheck shape

From the Compose Specification, `services.*.healthcheck`:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -f http://localhost/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
  disable: false
```

`test` can be a string (implying `CMD-SHELL`) or a list. `disable:
true` is equivalent to `test: ["NONE"]`.

## 7. Non-goals

- No new monitoring behavior (don't poll health status directly)
- No blocking on health check warnings (warnings only, never errors)
- No health check injection or defaults
