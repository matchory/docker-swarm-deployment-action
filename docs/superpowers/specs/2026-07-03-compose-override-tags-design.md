# Support for Compose `!reset` / `!override` Merge Tags

## Summary

Compose Specification files can use the `!reset` and `!override` YAML
tags to control how values merge across a base file and its overrides
(`!override` replaces a base value instead of deep-merging it; `!reset`
removes a base value). The action currently **crashes** on these tags:
js-yaml raises `unknown tag !<!reset>` at parse time, aborting the whole
deployment.

This adds correct support by routing the multi-file merge through
`docker compose config` **only when these tags are present**, then
feeding the tag-free merged result into the existing pipeline. When the
tags are present but the Docker Compose v2 plugin is unavailable, the
action fails with a clear, actionable error.

### Empirical basis (verified against Docker 29.4)

| Engine | `!override` on a list | `!reset` on a value |
| --- | --- | --- |
| js-yaml (`CORE_SCHEMA.withTags(mergeTag)`) | ❌ parse error | ❌ parse error |
| `docker stack config` (current merge) | ⚠️ appends (ignores tag) | ⚠️ keeps literal `"null"` |
| `docker compose config --no-interpolate` | ✅ replaces base list | ✅ removes the key |

Two independent problems: js-yaml can't parse the tags, and
`docker stack config` — the tool the action uses to merge files
(`engine.ts:41`) — does not honor their semantics. `docker compose
config --no-interpolate` handles both correctly **and** leaves `${VAR}`
references intact for the action's own interpolation step
(`interpolateSpec`), which was verified directly.

## Architecture

**Principle: surgical and zero-regression.** The behavior of the
existing pipeline is unchanged unless `!reset`/`!override` actually
appear in an input file. The dominant case (no tags — 124 of 125 files
in a real-world sample) takes exactly today's code path.

A new preprocessing step sits between compose-file resolution and
spec loading:

```
resolveComposeFiles → preMergeOverrides → loadComposeSpecs
  → normalizeSpec (docker stack config) → interpolateSpec → deploy
```

`preMergeOverrides(files, settings)`:

1. Read each resolved file's raw contents and scan for the tags (see
   Detection). If none are found, return the original `files` unchanged
   with a no-op `cleanup` — no Docker Compose invocation, no new
   dependency, no behavior change.
2. If any file uses the tags:
   - Verify the Docker Compose v2 plugin is available
     (`docker compose version`). If not, throw the error in Error
     Handling.
   - Run `docker compose config --no-interpolate` over **all** input
     files (in order), producing one canonical, tag-free YAML document
     with `!reset`/`!override` already applied and `${VAR}` preserved.
   - Write that document to a single temporary file
     (`docker-compose.merged.<uuid>.yaml`) and return `{ files:
     [tempFile], cleanup }`, where `cleanup` unlinks the temp file.
   - The caller invokes `cleanup` after `loadComposeSpecs` has parsed
     the merged file (via a `finally`).

Because the merged document is tag-free and in canonical Compose form,
`loadComposeSpecs` → `reconcileSpec` → `docker stack config` all run
exactly as they do for any ordinary compose file. `reconcile.ts` is not
touched.

### New units

- **`compose.ts: preMergeOverrides(files, settings): Promise<{ files: string[]; cleanup: () => Promise<void> }>`**
  Orchestrates detection, plugin check, merge, and temp-file lifecycle.
  Returns the effective file list and a `cleanup` thunk (a no-op when no
  temp file was created).
- **`compose.ts: hasOverrideTags(content: string): boolean`**
  Heuristic text scan (see Detection).
- **`engine.ts: isComposePluginAvailable(): Promise<boolean>`**
  Runs `docker compose version`; true on exit 0.
- **`engine.ts: mergeComposeFiles(files: string[]): Promise<string>`**
  Runs `docker compose <-f each> config --no-interpolate` and returns
  the merged YAML from stdout.

### Wiring

In the deploy orchestration (`deployment.ts`), replace the direct
`loadComposeSpecs(files, …)` call with:

```ts
const { files: effectiveFiles, cleanup } = await preMergeOverrides(files, settings);
try {
  const specs = await loadComposeSpecs(effectiveFiles, settings);
  // …normalizeSpec / interpolate / deploy as today…
} finally {
  await cleanup();
}
```

## Detection

`hasOverrideTags` is a text scan run on raw file contents before
parsing. It matches the tag tokens `!reset` and `!override`
(regex `/(^|[\s:\-[{,])!(reset|override)(?![\w-])/`), biased toward
**over**-detection:

- A false negative (missing a real tag) would let the file reach
  js-yaml and crash — unacceptable, so the scan must catch every real
  use.
- A false positive (e.g. the literal text `!override` inside a comment)
  only causes the fileset to route through `docker compose config`,
  which produces a correct result regardless — at worst it requires the
  Compose plugin for a file that didn't strictly need it. Given the
  plugin is a reasonable baseline (present on GitHub-hosted runners),
  this is an acceptable trade for guaranteed crash-avoidance.

We deliberately do **not** register the tags in the js-yaml schema:
that would avoid the crash but reintroduce the silent-mis-merge problem,
because the normal path merges via `docker stack config`, which ignores
the tags.

## Error handling

- **Plugin missing while tags are present** — throw:
  > `Compose file uses the "!reset"/"!override" merge tags, which require the Docker Compose v2 plugin ('docker compose') on the runner. Install it (it ships with GitHub-hosted runners) or inline the override.`

  This is a hard failure by design: without the plugin these files
  cannot be merged correctly, and a fallback to `docker stack config`
  would silently produce the wrong stack.
- **`docker compose config` exits non-zero** (invalid compose, missing
  `env_file`, unresolved `include`, etc.) — surface its stderr in the
  thrown error so the user sees Compose's own diagnostics.
- **Temp file cleanup** always runs via `finally`, mirroring the
  existing `normalizeSpec` cleanup of `docker-compose.generated.*`
  files.

## Interaction notes

- `docker compose config` is a **local** operation; it parses and merges
  files without contacting the Docker daemon, so it works regardless of
  the remote `DOCKER_HOST`/`DOCKER_CONTEXT` the action targets. (The
  implementation plan includes a verification step for this with a
  remote context set.)
- `--no-interpolate` preserves `${VAR}` so the action's own
  `interpolateSpec` remains the single interpolation authority
  (consistent with the existing `--skip-interpolation` passed to
  `docker stack config`).
- The merged output is modern Compose form (`name`, long-syntax ports,
  `networks: default: null`). `reconcileSpec` already deletes `name`
  and `docker stack config` already normalizes these — the same handling
  every compose file gets today.

## Testing

Unit tests (mocked `exec`, consistent with existing engine/compose
tests):

- `hasOverrideTags`: detects `!reset` and `!override` in key position
  (`x: !override`), sequence position (`- !override`), and bare; ignores
  ordinary text without the tag; documents that a tag inside a comment
  is (acceptably) detected.
- `preMergeOverrides`:
  - No tags → returns the original file list, invokes neither the plugin
    check nor `docker compose config`, and `cleanup` is a no-op.
  - Tags + plugin available → calls `mergeComposeFiles`, writes one temp
    file, returns it, and `cleanup` unlinks it.
  - Tags + plugin missing → throws the documented error; no merge
    attempted.
- `engine.isComposePluginAvailable` / `engine.mergeComposeFiles`: assert
  the exact `docker compose` argv (`config --no-interpolate`, one `-f`
  per file) and stdout/stderr handling.

One integration test, guarded by real Docker + Compose availability
(skipped otherwise): a base file with `ports`/`environment` and an
override using `ports: !override […]` and `env: !reset null` merges to
the expected result end-to-end through `preMergeOverrides`.

## Out of scope

- Reimplementing Compose's merge algorithm in TypeScript (rejected:
  large surface, duplicates what the action delegates to Docker).
- Falling back to `docker stack config` when the plugin is absent
  (rejected: silently wrong merges).
- Registering `!reset`/`!override` as pass-through tags in js-yaml
  (rejected: avoids the crash but produces wrong merges via
  `docker stack config`).
- `include` / `extends` resolution behavior — already handled by
  whichever merge tool runs; not changed here.
