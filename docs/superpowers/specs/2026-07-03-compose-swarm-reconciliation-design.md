# Compose → Swarm Active Reconciliation

## Summary

Make good on the action's core promise — "supports both the Compose
Specification and Compose File v3, so you don't have to worry about
incompatibilities" — by actively reconciling modern Compose
Specification constructs into `docker stack deploy`-compatible form
**before** the spec reaches `docker stack config`.

Today the action delegates all format reconciliation to
`docker stack config` and passes unknown keys through untouched
(`ComposeSpec` has an open `[key: string]: unknown` index signature,
`compose.ts:316-323`). Empirically, that means a modern compose file
using common keys (`mem_limit`, `cpus`, `gpus`, `profiles`,
`develop`, `depends_on` conditions, …) makes `docker stack config`
**hard-fail** — often with the cryptic `Configuration contains
forbidden properties`, which does not even name the offending key.

This design adds a reconciliation pass that translates what has a
faithful swarm equivalent, strips what does not (with a clear
warning), and validates unknown keys with actionable messages. An
opt-in `strict-compatibility` mode turns every warning into a hard
error.

### Empirical basis

All behavior below was verified against Docker `29.4.0`
`docker stack config` (the v3/legacy schema validator the action
already relies on):

| Key | `stack config` result |
| --- | --- |
| `mem_limit` | ❌ `Configuration contains forbidden properties` |
| `cpus` | ❌ `Additional property cpus is not allowed` |
| `gpus` | ❌ not allowed |
| `restart` (top-level) | ✅ accepted (but ignored by swarm at runtime) |
| `depends_on` (map/conditions) | ❌ `depends_on must be a list` |
| `label_file` | ❌ not allowed |
| `develop`, `post_start`, `profiles`, `provider`, `models` | ❌ not allowed |
| `container_name`, `build` | ✅ accepted (ignored by swarm at deploy) |

Verified translation targets that **pass** `stack config`:
`deploy.resources.limits.{cpus,memory}`, `deploy.restart_policy`,
`deploy.resources.reservations.generic_resources`, `depends_on` list
form, `labels` map. Notably, `deploy.resources.reservations.devices`
is **rejected** by the v3 schema — so GPUs have no faithful automatic
translation (see §2, `gpus`).

## Architecture

A new focused module `src/reconcile.ts` owns the compatibility logic.
It exports one function:

```ts
reconcileSwarmCompatibility(spec: ComposeSpec, settings: Settings): void
```

It mutates `spec` in place (consistent with `reconcileSpec`), emits
diagnostics via `@actions/core` (`core.warning`, matching
`healthcheck.ts`), and — in strict mode — collects violations and
throws a single aggregated error at the end listing every offending
key. The rule set is expressed as **data** (a catalog), not scattered
`if` branches, so adding a rule is a one-line table entry and each
rule is unit-testable in isolation.

**Call site:** `reconcileSpec` in `compose.ts`, after the
`services` presence check and before secret/config processing
(`compose.ts:193`). This runs per input file, so translation happens
**before** `normalizeSpec` serializes the spec and feeds it to
`docker stack config`. Because every translation target is a
v3-valid shape (verified above), `docker stack config` accepts the
reconciled output.

Data flow (unchanged except the new step, **bold**):

```
load → reconcileSpec[ delete name · force version · require services
      · RECONCILE COMPATIBILITY · process secrets/configs ]
     → normalizeSpec (dump → docker stack config) → interpolate → deploy
```

## 1. Translation rules (faithful swarm equivalent)

Each rule reads a source key from a service, writes the swarm
equivalent, and deletes the source. Translations are **non-clobbering**:
if the target is already set, the rule leaves it and emits a warning
about the conflict rather than overwriting user intent.

| Source (service) | Target | Notes |
| --- | --- | --- |
| `mem_limit` | `deploy.resources.limits.memory` | value string copied as-is (`512m`) |
| `mem_reservation` | `deploy.resources.reservations.memory` | `reservations.{cpus,memory}` verified v3-valid |
| `cpus` | `deploy.resources.limits.cpus` | serialized to string |
| `restart` | `deploy.restart_policy.condition` | value map below |
| `label_file` | merge into `labels` | reads `KEY=VAL` file(s); explicit `labels` win |
| `depends_on` (map form) | `depends_on` list of keys | conditions dropped — see note |

**`restart` value map** (compose → `restart_policy.condition`):
`no → none`, `always → any`, `on-failure[:N] → on-failure`,
`unless-stopped → any` (approximation — swarm has no
`unless-stopped`; emit a warning noting the substitution).

**`depends_on` conditions:** swarm has no startup-ordering or
health-gated dependencies. When `depends_on` is the long/map form, we
convert it to the list form Docker's schema requires and warn that
conditions (`service_healthy`, `required`, …) are not honored by
swarm. List-form `depends_on` is passed through unchanged.

**`label_file`:** accepts a string or list of paths, parsed as
`KEY=VALUE` lines (same format as `env_file`). Paths are resolved
relative to the compose file and confined to the workspace (reuse the
existing path-containment guard, `compose.ts:79-95`) to avoid reading
arbitrary files.

## 2. Strip-and-warn rules (no faithful swarm equivalent)

These keys cause `docker stack config` to hard-fail and have no v3
translation. We remove them and emit a warning explaining swarm does
not support the feature. Removal is what keeps the deploy working.

| Key | Scope | Warning gist |
| --- | --- | --- |
| `develop` | service | Dev-loop config; ignored outside `docker compose watch`. |
| `post_start` / `pre_stop` | service | Lifecycle hooks unsupported by swarm. |
| `profiles` | service | Profiles not supported; all services always deployed. |
| `provider` | service | Provider services cannot run on swarm. |
| `gpus` | service | No v3 equivalent; point user to `deploy.resources.reservations.generic_resources` + node labels. |
| `memswap_limit` (no v3 target) | service | Unsupported; swarm has no swap-limit control. |
| `models` | top-level | AI model runner unsupported by swarm. |

**`provider` caveat:** a provider service has no `image`. Stripping
only the key leaves an invalid service that `stack config` will still
reject. The rule therefore drops the **entire service** with a warning
naming it, so the rest of the stack deploys.

## 3. Warn-only rules (accepted but ineffective)

These pass `docker stack config` but are silently ignored by swarm at
deploy time. We leave them in place (removing them risks changing a
valid spec) and warn that they have no effect on swarm.

| Key | Warning gist |
| --- | --- |
| `container_name` | Swarm names tasks itself; ignored. |
| `build` | Swarm requires pre-built images; `build` is ignored — ensure `image` is set and pushed. |

## 4. Unknown-key validation (schema tightening, "D")

Maintain two constant sets: `KNOWN_TOP_LEVEL_KEYS` and
`KNOWN_SERVICE_KEYS`, sourced from the current Compose Specification.
After applying the catalog, any remaining key that is (a) not in the
known set and (b) not handled by a rule is reported as an unknown
property — pre-empting Docker's opaque `forbidden properties`.

- Message names the exact key and service, e.g.
  `Unknown property "mem_limt" on service "api"`.
- When a close match exists (Levenshtein distance ≤ 2 against the
  known set), append a suggestion: `— did you mean "mem_limit"?`.
- Default: `core.warning`. Strict mode: contributes to the thrown
  error.

This does not attempt to be a full compose-spec JSON-schema
validator; it is a targeted typo/footgun catcher layered on top of
the existing `docker stack config` validation.

## 5. Strict mode

New action input `strict-compatibility` (boolean, default `false`),
parsed in `settings.ts` alongside the existing `strictVariables`
(`strict-variables`) and surfaced as `settings.strictCompatibility`.
Add the corresponding entry to `action.yml`.

- Default (`false`): every rule above emits `core.warning` and the
  deploy proceeds with the reconciled spec.
- `true`: `reconcileSwarmCompatibility` collects all violations
  (translations with conflicts, strips, warn-only hits, unknown keys)
  and throws one aggregated error enumerating them, failing the
  action before deploy.

Translations that apply cleanly (no conflict) are **not** violations —
they are the feature working — so strict mode does not fail on a
successful `mem_limit → deploy.resources.limits.memory` rewrite.

## Testing

`tests/reconcile.test.ts`, unit-level, no Docker dependency (assert on
the transformed object):

- One test per translation rule: source removed, target written with
  the correct value/shape, `restart` value-map coverage.
- Non-clobbering: pre-existing `deploy.resources.limits.memory` is not
  overwritten by `mem_limit`; conflict warning emitted.
- `label_file` parsing + path-containment rejection.
- `depends_on` map→list conversion + conditions-dropped warning;
  list form untouched.
- Each strip rule removes its key and warns; `provider` drops the
  whole service.
- Warn-only rules leave the key intact and warn.
- Unknown-key detection with and without a did-you-mean suggestion.
- Strict mode: warnings become a single thrown error; clean
  translations do **not** throw.

One integration-style test in `tests/compose.test.ts` feeds a modern
multi-key spec through `reconcileSpec` and asserts the result contains
only v3-compatible keys (the shapes verified in this doc).

## Out of scope

- **Profile resolution** (activating/filtering services by an enabled
  profile) — we strip `profiles` and warn only.
- **`include` / `extends` resolution** — left to `docker stack config`
  (behavior under-documented; not regressed by this work).
- **`env_file`** — `docker stack config` already attempts to resolve
  it; excluded pending confirmation, to avoid double-handling.
- **GPU auto-translation** — semantically lossy and node-dependent;
  strip-and-warn only.
- **Custom YAML tags** (`!include`, `!env`, `!file`) — a separate
  authoring-sugar track, deliberately not bundled here.
