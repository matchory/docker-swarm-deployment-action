# Reconcile After Merge: Swarm Reconciliation on the Tag-Free Merged Spec

## Summary

PR #154 added support for the standard Compose `!reset` / `!override`
merge tags by registering them as round-tripping js-yaml tags and merging
tag-bearing files through `docker compose config` (which honors the tags)
instead of `docker stack config` (which does not). To preserve the
action's "transform before any Docker tool sees the spec" invariant, that
feature runs the **full** per-file transform — including
`reconcileSwarmCompatibility` — **before** the merge. Because reconcile
then runs per file, on specs that still carry `Tagged` carriers, three
legitimate override usages had to be **rejected** by a guard
(`assertMergeableTagUsage`) rather than working:

1. `deploy: !override {…}` on a service that also sets a short-form key
   (`restart` / `mem_limit` / `cpus` / `mem_reservation`).
2. `labels: !override {…}` on a service that also uses `label_file`.
3. `depends_on: !override [x]` (a reconciled key — rejected outright).

This rework makes those cases **just work** by running
`reconcileSwarmCompatibility` **after** the merge, on the tag-free merged
output, so reconcile never encounters a `Tagged` carrier. The guard is
then removed entirely.

## Empirical basis (verified against Docker 29.4 / Compose v5.1.2)

Do **not** re-derive these; they were verified end-to-end with the real
tools.

### Showstopper check — CLEARED

The current tag path already sends processed secrets (renamed to
`<name>-<hash7>`, with an explicit `name:` and rotation labels) through
`docker compose config`. Verified that compose config **preserves an
explicitly-set `secrets.*.name` and all custom labels verbatim** — it
does not re-derive or prefix the name, and does not strip labels. So
hash-based rotation and pruning remain intact, and the secret transform
can keep running pre-merge exactly as today. There is no latent bug in
the current feature, and no new constraint on this rework.

### The decisive finding

`docker compose config --no-interpolate` **honors the override tags but
does not perform swarm reconciliation.** It resolves every tag to a
plain, tag-free value and leaves the modern keys in place for us to
reconcile afterwards:

| Input (tag path) | `docker compose config` output | post-merge reconcile does |
| --- | --- | --- |
| `deploy: !override {replicas:3}` + `restart: always` | `deploy: {replicas:3}` and `restart: always` — both kept | folds `restart` → `deploy.restart_policy` alongside `replicas:3` |
| `labels: !override {…}` + `label_file` | labels overridden; `label_file` kept, path **absolutized** | merges label_file into labels |
| `depends_on: !override [db]` | `depends_on: {db: {condition…}}` (long map form) | converts map → list |
| `restart: !override always` | `restart: always` (tag stripped) | translates to `restart_policy` |
| `restart: !reset null` | key removed entirely | nothing to do |

Two consequences follow:

- **Reconcile never sees a `Tagged` carrier in either path.** Tag path:
  compose config strips all tags before reconcile runs. Non-tag path:
  there were never any carriers. So the guard `assertMergeableTagUsage`
  guards against a state that can no longer occur — it is removed.
- **`baseDir` is irrelevant for the tag path.** compose config rewrites
  `label_file` entries to absolute paths, so post-merge reconcile
  resolves them regardless of the working directory. The tag path
  reconciles the merged spec with the default `baseDir` (`process.cwd()`).

### Why the secret transform must still precede the merge

`docker compose config` rejects `secrets.*.content` (`additional
properties 'content' not allowed`) — the action's synthetic-secret
feature. It accepts file-based secrets. So the `content:` /
`environment:` → file conversion (`processVariable` /
`transformVariable`) must run **before** the merge. It is the **only**
transform that must. `reconcileSwarmCompatibility` (which strips
`develop` / `profiles` / …, translates `mem_limit` → `deploy.resources`,
`restart` → `deploy.restart_policy`, `depends_on` map → list,
`label_file` → `labels`) must run before `docker stack config` (which
rejects those modern keys) but **not** before `docker compose config`
(which accepts them). This split is the crux of the rework.

## Architecture

`reconcileSpec` today conflates two responsibilities that this rework
separates:

- **prepare** (per file, always, cwd-relative): strip `name`, force
  `version`, require `services`, convert `content:` / `environment:`
  secrets/configs to files via `processVariable`.
- **reconcile** (`reconcileSwarmCompatibility`, needs `baseDir`):
  translate modern keys, strip swarm-incompatible keys, drop provider
  services, plus the "all services removed" empty-check.

The load phase runs only **prepare**. `normalizeSpec` becomes the single
owner of merge + reconcile ordering.

```
resolveComposeFiles
  → loadComposeSpecs          parse (tag-aware schema) + prepare per file
                              → returns { spec, baseDir }[]
  → normalizeSpec             usesTags?
                                yes → compose-merge → reconcile(merged)
                                      → stack config normalize
                                no  → reconcile each(baseDir)
                                      → stack config merge+normalize
  → interpolateSpec → deploy
```

### 1. `loadComposeSpec` / `loadComposeSpecs` — prepare only

- `loadComposeSpec(filename, settings)` parses with `composeSchema`
  (unchanged) and runs a new `prepareSpec` (the old `reconcileSpec` minus
  reconcile and minus the guard). Returns `{ spec, baseDir }` where
  `baseDir = dirname(filename)`.
- `prepareSpec(spec, settings)`:
  1. delete `spec.name`
  2. default `spec.version` to `schemaVersion`
  3. throw if `services` is missing or empty
  4. if `settings.manageVariables`, run `processVariable` over every
     `secrets` and `configs` entry (unchanged from today, including the
     `startGroup` / `endGroup` framing)
- `loadComposeSpecs` returns `{ spec, baseDir }[]`.

`prepareSpec` needs no `baseDir`: `processVariable` reads/writes
`.secret` files relative to `process.cwd()`, not the compose file's
directory.

### 2. `normalizeSpec` — merge + reconcile ordering

`normalizeSpec(prepared: { spec: ComposeSpec; baseDir: string }[],
settings)`:

```
const usesTags = prepared.some(({ spec }) => containsOverrideTag(spec));
const spec = usesTags
  ? await mergeThenReconcile(prepared, settings)
  : await reconcileThenMerge(prepared, settings);

if (!spec?.services || Object.keys(spec.services).length === 0) {
  throw new Error("Invalid stack specification: Missing services section");
}
return spec;
```

- **`reconcileThenMerge`** (non-tag path — byte-identical runtime to
  today):
  1. for each `{ spec, baseDir }`: `await reconcileSwarmCompatibility(
     spec, settings, baseDir)`, then the "all services removed"
     empty-check.
  2. dump each spec (`{ schema: composeSchema }`) to a temp file.
  3. `normalizeStackSpecification(tempFiles, settings, true)` — stack
     config merges + normalizes.
  4. `finally` unlink temp files.

- **`mergeThenReconcile`** (tag path):
  1. if `!(await isComposePluginAvailable())`, throw the documented
     plugin-missing error.
  2. dump each spec (`{ schema: composeSchema }`) to a temp file so
     `Tagged` carriers re-emit.
  3. `merged = await mergeComposeFiles(tempFiles)` — compose config,
     tag-free YAML with `${VAR}` intact.
  4. parse `merged` with `{ json: true }` (tag-free plain objects).
  5. `await reconcileSwarmCompatibility(mergedSpec, settings)` (default
     `baseDir`), then the "all services removed" empty-check.
  6. dump `mergedSpec` to one temp file;
     `normalizeStackSpecification([mergedFile], settings, true)`.
  7. `finally` unlink all temp files.

Both helpers share the temp-file lifecycle pattern. The empty-check
("All services were removed during reconciliation …") moves from the old
`reconcileSpec` into both helpers, adjacent to the reconcile call it
diagnoses.

### 3. Guard removal (`override-tags.ts`, `reconcile.ts`)

- Delete `assertMergeableTagUsage` from `override-tags.ts` and its import
  of `deployFoldingKeys` / `reconciledServiceKeys`.
- Delete the now-unused `reconciledServiceKeys` and `deployFoldingKeys`
  exports from `reconcile.ts` (introduced solely for the guard).
- Keep `Tagged`, `overrideTagDefinitions`, `containsOverrideTag`.
- Remove the guard call from the load path.

### 4. `deployment.ts` wiring

`deploy()` passes the `{ spec, baseDir }[]` from `loadComposeSpecs`
straight into `normalizeSpec`. No other flow change.

## Error handling

- **Plugin missing while tags are present** — unchanged hard error (never
  a silent fallback to `docker stack config`):
  > `Compose file uses the "!reset"/"!override" merge tags, which require the Docker Compose v2 plugin ('docker compose') on the runner. Install it (it ships with GitHub-hosted runners) or inline the override.`
- **`docker compose config` exits non-zero** — its stderr surfaces via
  `executeDockerCommand`'s existing behavior.
- **All services removed by reconciliation** — the existing empty-check
  error, now raised from `normalizeSpec` (per spec on the non-tag path,
  on the merged spec on the tag path).
- **Temp files** always cleaned up via each helper's `finally`.

## Interaction notes

- `docker compose config` is local (no daemon); verified to complete
  within a second under a bogus remote `DOCKER_HOST`, so it is unaffected
  by the remote host the action targets.
- `--no-interpolate` preserves `${VAR}` so the action's own
  `interpolateSpec` remains the single interpolation authority.
- The secret transform still runs pre-merge, so `content:` secrets are
  file-based before either Docker tool sees the spec — the reason the
  merge can run at all.

## Testing

Unit tests (mocked `exec` / `fs`, consistent with existing suites):

- **`override-tags.test.ts`**: keep the round-trip and
  `containsOverrideTag` suites. Remove the `assertMergeableTagUsage`
  suite.
- **`compose.test.ts`**:
  - `loadComposeSpecs` / `loadComposeSpec` now return `{ spec, baseDir }`;
    the prepare-behavior tests (name removal, version add/preserve,
    services-missing/empty throw, secret/config processing, skip when
    `manageVariables` is false) assert on `.spec`.
  - Relocate the two reconcile tests ("reconciles modern compose keys …",
    "throws … when reconciliation removes all services") to exercise
    `normalizeSpec` (non-tag path), since reconcile now runs there.
  - Drop the "rejects a merge tag placed on a reconciled key" test.
  - `normalizeSpec` non-tag test feeds `{ spec, baseDir }[]` and asserts
    the `docker stack config` argv (unchanged).
  - `normalizeSpec` tag tests: with tags present, plugin check →
    `mergeComposeFiles` → reconcile → `normalizeStackSpecification` on the
    single merged file; plugin-missing throws the documented error;
    reconcile is applied to the merged spec (e.g. a merged `restart` is
    translated).
- **`deployment.test.ts`**: `loadComposeSpecs` mock returns
  `{ spec, baseDir }[]`; `normalizeSpec` is called with it.
- **`merge.test.ts`**: `loadComposeSpecs` no longer reconciles, so the
  `<<:` merge-key test asserts the prepared (merged-but-not-reconciled)
  shape — still proving anchor/alias merging works. (Reconcile behavior
  itself stays covered by `reconcile.test.ts`.)

Integration test (guarded by real Docker + Compose; skipped otherwise) —
this is the real-tool proof the DoD requires, not just mocks:

- A base + override exercising each DoD case through the actual
  `docker compose config` merge and the post-merge reconcile:
  1. `deploy: !override {replicas:3}` with `restart: always` → merged
     `deploy` has **both** `replicas: 3` and a translated
     `restart_policy`; nothing dropped.
  2. `labels: !override {…}` with `label_file` → labels correct.
  3. `depends_on: !override [x]` → reconciles to a list.
  Plus a file-based secret with an explicit `name:` and custom labels →
  name and labels survive the merge (rotation/pruning intact).

## Definition of done

- The three previously-rejected cases succeed, proven by a real-tool
  test (not only mocks).
- `assertMergeableTagUsage` and the `reconciledServiceKeys` /
  `deployFoldingKeys` exports are gone; no guard remains.
- Non-tag path runtime behavior is unchanged.
- `npm run all` green; `dist/` rebuilt.

## Out of scope

- Reimplementing Compose's merge algorithm in TypeScript.
- Falling back to `docker stack config` when the plugin is absent.
- Custom/invented tags; the generic unknown-tag passthrough.
- Any change to `reconcileSwarmCompatibility`'s translation logic itself
  — only *when* it runs changes.
