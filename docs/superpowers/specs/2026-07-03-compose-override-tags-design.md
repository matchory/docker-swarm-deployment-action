# Support for Compose `!reset` / `!override` Merge Tags

## Summary

Compose Specification files can use the `!reset` and `!override` YAML
tags to control how values merge across a base file and its overrides
(`!override` replaces a base value instead of deep-merging it; `!reset`
removes a base value). These are the only two tags the Compose Spec
defines. The action currently **crashes** on them: js-yaml raises
`unknown tag !<!reset>` at parse time, aborting the whole deployment.

We add support while **preserving the action's core invariant — that we
transform the spec (reconcile modern→swarm, convert `content:`/
`environment:` secrets to files) before any Docker tool sees it.** We do
this by registering `!reset`/`!override` as **round-tripping** tags in
the parse schema: they survive our transforms untouched and are
re-emitted on serialization. When (and only when) these tags are
present, the multi-file merge is performed by `docker compose config`
(which honors the tags) instead of `docker stack config` (which does
not), and the tag-free merged result is then normalized to swarm form as
usual. When the tags are present but the Docker Compose v2 plugin is
unavailable, the action fails with a clear, actionable error.

### Empirical basis (verified against Docker 29.4 + js-yaml v5)

| Concern | Result |
| --- | --- |
| js-yaml parsing the tags with `CORE_SCHEMA.withTags(mergeTag)` | ❌ `unknown tag` — crashes |
| js-yaml **round-trip** with custom scalar/sequence/mapping tags | ✅ load → transform → `dump` re-emits `!reset`/`!override` intact |
| `docker stack config` honoring the tags | ❌ `!override` appends; `!reset null` kept as literal `"null"` |
| `docker compose config --no-interpolate` honoring the tags | ✅ replaces / removes correctly; preserves `${VAR}` |
| `docker compose config` on a **raw** `content:` secret | ❌ `additional properties 'content' not allowed` |
| `docker compose config` on a **transformed** (file-based) secret | ✅ accepted and merged |

The last two rows are why the merge must run **after** our transform,
not before: the action's synthetic-secret feature (`content:` /
`environment:` sources, used to build secrets from generated values or
concatenated env files at CI time) produces constructs `docker compose
config` rejects until we have converted them to files.

## Architecture

The transform-first pipeline is unchanged in shape; two things are
added, both gated on the tags actually being present.

```
resolveComposeFiles
  → loadComposeSpecs        (parse with tag-aware schema; tags preserved)
      → reconcileSpec       (reconcile + secret transform; tags untouched)
  → normalizeSpec           (merge: docker compose config if tags, else
                             docker stack config; then swarm-normalize)
  → interpolateSpec → deploy
```

Because `reconcileSpec` runs before the merge exactly as today, secrets
are already file-based and the spec is already reconciled by the time
any Docker tool runs — the invariant holds by construction.

### 1. Round-tripping tag registration

A new module `src/override-tags.ts` provides:

- `class Tagged { tag: string; kind: "scalar" | "sequence" | "mapping"; value: unknown }`
  — the in-memory carrier for a tagged node.
- `overrideTagDefinitions` — the js-yaml tag definitions for `!reset`
  and `!override`, one `defineScalarTag`/`defineSequenceTag`/
  `defineMappingTag` per tag (six total), each loading into a `Tagged`
  and, on dump, re-emitting the original tag. Structured as a helper
  `overrideTag(tagName)` returning the three kind-definitions, so adding
  a future standard tag is a one-line change.
- `containsOverrideTag(value: unknown): boolean` — deep-scans a parsed
  spec for any `Tagged` instance.

`compose.ts` extends its existing schema:

```ts
const composeSchema = CORE_SCHEMA.withTags(mergeTag, ...overrideTagDefinitions);
```

This alone stops the parse crash; tagged nodes become `Tagged` carriers
that survive to `dump`.

Verified round-trip (mapping `represent` must return a `Map`; scalar
`represent` returns the source string; sequence returns the array):
`ports: !override [...]`, `environment: !reset null`, and
`labels: !override {...}` all serialize back byte-faithfully after an
unrelated transform edits the same service.

### 2. Merge-tool selection in `normalizeSpec`

`normalizeSpec` today writes each reconciled spec to a temp file and
runs one `docker stack config --compose-file=… --skip-interpolation`
(merge + swarm-normalize). Changes:

- Always serialize with the tag-aware schema:
  `dump(spec, { schema: composeSchema })` (required so `Tagged` carriers
  re-emit; identical output for tag-free specs).
- Compute `const usesTags = composeSpecs.some(containsOverrideTag)`.
- **No tags** → today's behavior, unchanged.
- **Tags present:**
  1. Verify the Docker Compose v2 plugin (`isComposePluginAvailable`);
     if absent, throw the Error-handling message.
  2. `mergeComposeFiles(tempFiles)` → `docker compose config
     --no-interpolate` over all files, honoring the tags, producing one
     canonical tag-free YAML document (with `${VAR}` intact).
  3. Write that document to one temp file and run the existing
     `normalizeStackSpecification([mergedFile], settings, true)` to
     swarm-normalize and validate it.
  4. Clean up all temp files (as today).

### 3. New engine helpers (`src/engine.ts`)

- `isComposePluginAvailable(): Promise<boolean>` — runs `docker compose
  version` via the existing `executeDockerCommand`; true on success,
  false on error.
- `mergeComposeFiles(files: string[]): Promise<string>` — runs `docker
  compose --file <a> --file <b> … config --no-interpolate` and returns
  the merged YAML (stdout).

Both go through the same private `executeDockerCommand` helper used for
every other Docker call, so error surfacing and grouping are consistent.

### 4. Edge-case guard: tags on reconciled keys

`!reset`/`!override` are meaningful on *mergeable collections* (`ports`,
`volumes`, `environment`, `labels`, `command`, `dns`, …) — none of which
reconciliation touches, so their carriers pass through untouched. A tag
placed directly on a scalar key that reconciliation *reads* would be
mishandled (e.g. `restart: !override always` → `String(Tagged)`), so we
reject it explicitly rather than mis-transform silently.

A validator `assertMergeableTagUsage(spec)` (in `override-tags.ts`, run
from `reconcileSpec` before `reconcileSwarmCompatibility`) throws a clear
error if a `Tagged` value sits on any tag-sensitive service key:
`mem_limit`, `mem_reservation`, `cpus`, `restart`, `depends_on`,
`label_file`. Message names the service, key, and tag, and explains the
tags apply to mergeable collections. `reconcile.ts` itself is untouched.

## Error handling

- **Plugin missing while tags are present** — hard error (never a silent
  fallback to `docker stack config`, which mis-merges these tags):
  > `Compose file uses the "!reset"/"!override" merge tags, which require the Docker Compose v2 plugin ('docker compose') on the runner. Install it (it ships with GitHub-hosted runners) or inline the override.`
- **`docker compose config` exits non-zero** — surface its stderr in the
  thrown error (via `executeDockerCommand`'s existing behavior).
- **Tag on a reconciled key** — the §4 guard's error.
- **Temp files** always cleaned up via the existing `normalizeSpec`
  finally/cleanup path.

## Interaction notes

- `docker compose config` is a **local** operation; it merges/validates
  files without contacting the daemon, so it is unaffected by the remote
  `DOCKER_HOST`/`DOCKER_CONTEXT` the action targets. (The plan includes a
  verification step under a remote host.)
- `--no-interpolate` preserves `${VAR}` so the action's own
  `interpolateSpec` remains the single interpolation authority
  (consistent with `--skip-interpolation` on `docker stack config`).
- The transform-first ordering means `docker compose config` only ever
  sees already-reconciled, file-based-secret specs — so the
  `content:`-secret feature and modern-key reconciliation both keep
  working with override tags in play.

## Scope decisions

- **Only the two standard Compose tags** (`!reset`, `!override`) are
  added. They are safe because real `docker compose` understands them,
  so tagged files remain portable.
- **No invented/custom tags** (`!env`, `!file`, `!include`, `!secret`):
  they would make files only this action can parse (portability
  regression) and duplicate existing mechanisms — `${VAR}` interpolation,
  `content:`/`env_file` secret sources, and the standard top-level
  `include:` (already resolved by `docker compose config`).
- **No generic unknown-tag passthrough** yet. The `overrideTag` helper
  is the extension point if a future standard tag or a
  `matchByTagPrefix` catch-all becomes warranted.

## Testing

Unit tests (mocked `exec`/`fs`, consistent with existing suites):

- `override-tags`: round-trip — a doc with scalar (`!reset null`),
  sequence (`!override [...]`), and mapping (`!override {...}`) tags,
  loaded with the schema and `dump`ed back, re-emits each tag; an
  unrelated edit to the same service does not disturb them.
  `containsOverrideTag` true/false cases. `assertMergeableTagUsage`
  throws for a tag on each sensitive key and passes for tags on
  `ports`/`environment`.
- `compose.ts` schema: a spec using `!override` now parses (no throw);
  `dump(spec, { schema: composeSchema })` reproduces the tag.
- `engine.ts`: `isComposePluginAvailable` (true/false) and
  `mergeComposeFiles` (exact `docker compose --file … config
  --no-interpolate` argv; returns stdout).
- `compose.ts` `normalizeSpec`: no-tag specs take the `docker stack
  config` path (unchanged); tag-bearing specs invoke the plugin check
  then `mergeComposeFiles` then `normalizeStackSpecification` on the
  single merged file; plugin-missing throws the documented error.

One integration test, guarded by real Docker + Compose availability
(skipped otherwise): a base with a `content:` secret and an override
using `ports: !override […]` + `<key>: !reset null` deploys-configures
end-to-end to the expected merged, swarm-normalized spec — proving the
content-secret + override-tag combination works.

## Out of scope

- Reimplementing Compose's merge algorithm in TypeScript.
- Falling back to `docker stack config` when the plugin is absent.
- Custom/invented tags and the generic unknown-tag passthrough (above).
- `include` / `extends` resolution behavior — handled by whichever merge
  tool runs; unchanged here.
