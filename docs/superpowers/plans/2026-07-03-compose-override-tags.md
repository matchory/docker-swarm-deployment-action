# Compose `!reset` / `!override` Merge-Tag Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the action crashing on Compose `!reset`/`!override` merge tags by routing the multi-file merge through `docker compose config` when those tags are present, then feeding the tag-free result into the existing pipeline.

**Architecture:** A new `preMergeOverrides` preprocessing step runs between `resolveComposeFiles` and `loadComposeSpecs`. It text-scans the raw files for the tags; if none are present it returns the files untouched (existing behavior). If present, it verifies the Docker Compose v2 plugin, merges all files via `docker compose config --no-interpolate` into one temp file, and returns that. `reconcile.ts` is untouched.

**Tech Stack:** TypeScript (strict, ESM), `@actions/exec`, `@actions/core`, js-yaml, Vitest, Biome. Node 24.

## Global Constraints

- Runtime: Node 24, ESM (`"type": "module"`). Intra-repo imports use the `.js` extension **except** imports from `./engine`, which the existing code writes without an extension (`import { normalizeStackSpecification } from "./engine"`) — match the file you edit.
- Tooling: **Biome** for lint/format (double quotes, semicolons); **Vitest** for tests. Run `npm run format:write` before committing each task; run `npm run all` before pushing (rebuilds the committed `dist/`).
- Docker is invoked only through the private `executeDockerCommand(args, opts)` helper in `src/engine.ts`; it runs `docker <args>`, returns collected stdout as a string, and throws on non-zero exit. `docker compose …` is expressed as args beginning with `"compose"`.
- The merge must use `--no-interpolate` so `${VAR}` references survive for the action's own `interpolateSpec` step (verified: `docker compose config --no-interpolate` honors `!reset`/`!override` and preserves `${VAR}`).
- Plugin-missing while tags are present is a **hard error**, never a silent fallback to `docker stack config` (which mis-merges these tags).
- No new npm dependencies.

## File Structure

- **Modify** `src/engine.ts` — add `isComposePluginAvailable()` and `mergeComposeFiles(files)` (both reuse `executeDockerCommand`).
- **Modify** `src/compose.ts` — add exported `hasOverrideTags(content)` and `preMergeOverrides(files)`; import the two new engine functions.
- **Modify** `src/deployment.ts` — call `preMergeOverrides` between resolve and load, with `try/finally` cleanup.
- **Modify** `tests/engine.test.ts`, `tests/compose.test.ts`, `tests/deployment.test.ts`.
- **Modify** `README.md` — note the Compose-plugin requirement for these tags.

---

### Task 1: `hasOverrideTags` detection

**Files:**
- Modify: `src/compose.ts` (add near the top, after the imports / `schemaVersion`)
- Test: `tests/compose.test.ts`

**Interfaces:**
- Produces: `hasOverrideTags(content: string): boolean` — true when the raw text contains a `!reset` or `!override` YAML tag token. Biased toward over-detection (a tag inside a comment counts); never misses a real tag.

- [ ] **Step 1: Write the failing test**

Add a new describe block to `tests/compose.test.ts`. Add `hasOverrideTags` to the existing `from "../src/compose"` / `"../src/compose.js"` import first.

```ts
describe("hasOverrideTags", () => {
  it.each([
    ["key position", "services:\n  web:\n    ports: !override\n      - '80:80'\n"],
    ["sequence position", "services:\n  web:\n    dns:\n      - !override 1.1.1.1\n"],
    ["reset tag", "services:\n  web:\n    environment: !reset null\n"],
    ["line start", "!override\n"],
  ])("detects an override tag in %s", (_label, content) => {
    expect(hasOverrideTags(content)).toBe(true);
  });

  it.each([
    ["plain spec", "services:\n  web:\n    image: nginx\n    restart: always\n"],
    ["word containing override", "services:\n  web:\n    image: my-override-image\n"],
  ])("does not flag %s", (_label, content) => {
    expect(hasOverrideTags(content)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compose.test.ts -t hasOverrideTags`
Expected: FAIL — `hasOverrideTags is not a function` / not exported.

- [ ] **Step 3: Implement**

In `src/compose.ts`, after the `schemaVersion` / `composeSchema` declarations:

```ts
// Matches the `!reset` / `!override` Compose merge tags as YAML tag tokens.
// Biased toward over-detection: a false positive only routes the files through
// `docker compose config` (still correct); a false negative would let js-yaml
// crash on the unknown tag.
const overrideTagPattern = /(^|[\s:\-[{,])!(reset|override)(?![\w-])/m;

/**
 * Report whether raw compose file contents use the `!reset` / `!override`
 * merge tags, which require `docker compose config` to merge correctly.
 */
export function hasOverrideTags(content: string): boolean {
  return overrideTagPattern.test(content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compose.test.ts -t hasOverrideTags`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: detect !reset/!override compose merge tags"
```

---

### Task 2: engine helpers — plugin check and compose merge

**Files:**
- Modify: `src/engine.ts` (add after `normalizeStackSpecification`, ~line 88)
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: the private `executeDockerCommand(args, opts)` (same file).
- Produces:
  - `isComposePluginAvailable(): Promise<boolean>` — runs `docker compose version`; true on success, false if the command errors.
  - `mergeComposeFiles(files: string[]): Promise<string>` — runs `docker compose --file <a> --file <b> … config --no-interpolate` and returns the merged YAML (stdout).

- [ ] **Step 1: Write the failing test**

Add to `tests/engine.test.ts` (it already has `mockedExec = vi.mocked(exec)` and mocks `@actions/exec`):

```ts
describe("isComposePluginAvailable", () => {
  it("returns true when `docker compose version` succeeds", async () => {
    mockedExec.mockResolvedValue(0);
    await expect(engine.isComposePluginAvailable()).resolves.toBe(true);
    expect(mockedExec).toHaveBeenCalledWith(
      "docker",
      ["compose", "version"],
      expect.any(Object),
    );
  });

  it("returns false when the command errors", async () => {
    mockedExec.mockRejectedValue(new Error("unknown command"));
    await expect(engine.isComposePluginAvailable()).resolves.toBe(false);
  });
});

describe("mergeComposeFiles", () => {
  it("runs `docker compose … config --no-interpolate` and returns stdout", async () => {
    const merged = "services:\n  web:\n    image: nginx\n";
    mockedExec.mockImplementation(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(merged));
      return 0;
    });

    await expect(
      engine.mergeComposeFiles(["base.yaml", "override.yaml"]),
    ).resolves.toBe(merged);

    expect(mockedExec).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "--file",
        "base.yaml",
        "--file",
        "override.yaml",
        "config",
        "--no-interpolate",
      ],
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine.test.ts -t "isComposePluginAvailable|mergeComposeFiles"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

In `src/engine.ts`, after `normalizeStackSpecification`:

```ts
/**
 * Check whether the Docker Compose v2 plugin (`docker compose`) is available
 * on the runner. Used to gate features that require it.
 */
export async function isComposePluginAvailable(): Promise<boolean> {
  try {
    await executeDockerCommand(["compose", "version"], { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge multiple compose files with `docker compose config`, honoring the
 * `!reset` / `!override` merge tags (which `docker stack config` ignores).
 * `--no-interpolate` preserves `${VAR}` references for the action's own
 * interpolation step. Returns the merged, tag-free YAML document.
 */
export async function mergeComposeFiles(files: string[]): Promise<string> {
  const fileFlags = files.flatMap((file) => ["--file", file]);
  return executeDockerCommand(
    ["compose", ...fileFlags, "config", "--no-interpolate"] as [
      string,
      ...string[],
    ],
    { silent: true },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine.test.ts -t "isComposePluginAvailable|mergeComposeFiles"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/engine.ts tests/engine.test.ts
git commit -m "feat: add docker compose plugin check and merge helpers"
```

---

### Task 3: `preMergeOverrides` orchestration

**Files:**
- Modify: `src/compose.ts` (add the function; extend the `./engine` import)
- Test: `tests/compose.test.ts`

**Interfaces:**
- Consumes: `hasOverrideTags` (Task 1); `isComposePluginAvailable`, `mergeComposeFiles` (Task 2); `readFile`, `writeFile`, `unlink` from `node:fs/promises` and `randomUUID` (already imported in `compose.ts`).
- Produces: `preMergeOverrides(files: readonly [string, ...string[]]): Promise<{ files: readonly [string, ...string[]]; cleanup: () => Promise<void> }>`. When no tags: returns the input `files` and a no-op `cleanup`. When tags present: throws if the plugin is missing; otherwise merges to a temp file `docker-compose.merged.<uuid>.yaml`, returns `{ files: [tempFile], cleanup }` where `cleanup` unlinks it.

- [ ] **Step 1: Write the failing test**

In `tests/compose.test.ts`, add `import * as engine from "../src/engine"` at the top if not present, and add `preMergeOverrides` to the compose import. The file already mocks `node:fs/promises` with hoisted `readFile`/`writeFile`/`unlink` and `node:crypto` (spy). Add:

```ts
describe("preMergeOverrides", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the files unchanged and a no-op cleanup when no tags are present", async () => {
    readFile.mockResolvedValue("services:\n  web:\n    image: nginx\n");
    const pluginSpy = vi.spyOn(engine, "isComposePluginAvailable");
    const mergeSpy = vi.spyOn(engine, "mergeComposeFiles");

    const result = await preMergeOverrides(["docker-compose.yaml"]);

    expect(result.files).toEqual(["docker-compose.yaml"]);
    expect(pluginSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("merges via docker compose and returns a temp file when tags are present", async () => {
    readFile.mockResolvedValue("services:\n  web:\n    ports: !override ['80:80']\n");
    vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
    vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
      "services:\n  web:\n    image: nginx\n",
    );

    const result = await preMergeOverrides(["base.yaml", "override.yaml"]);

    expect(engine.mergeComposeFiles).toHaveBeenCalledWith(["base.yaml", "override.yaml"]);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/),
      "services:\n  web:\n    image: nginx\n",
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/^docker-compose\.merged\..*\.yaml$/);

    await result.cleanup();
    expect(unlink).toHaveBeenCalledWith(result.files[0]);
  });

  it("throws a clear error when the plugin is missing and tags are present", async () => {
    readFile.mockResolvedValue("services:\n  web:\n    environment: !reset null\n");
    vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(false);
    const mergeSpy = vi.spyOn(engine, "mergeComposeFiles");

    await expect(preMergeOverrides(["override.yaml"])).rejects.toThrow(
      /Docker Compose v2 plugin/,
    );
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compose.test.ts -t preMergeOverrides`
Expected: FAIL — `preMergeOverrides is not a function`.

- [ ] **Step 3: Implement**

In `src/compose.ts`, extend the engine import:

```ts
import {
  isComposePluginAvailable,
  mergeComposeFiles,
  normalizeStackSpecification,
} from "./engine";
```

Add the function (near `hasOverrideTags`):

```ts
/**
 * When any input file uses the `!reset` / `!override` merge tags, merge all
 * files up front with `docker compose config` (js-yaml cannot parse those tags
 * and `docker stack config` ignores their semantics), returning a single
 * tag-free temp file for the normal pipeline to consume. Otherwise returns the
 * files unchanged. The caller must invoke `cleanup` once the files are loaded.
 */
export async function preMergeOverrides(
  files: readonly [string, ...string[]],
): Promise<{
  files: readonly [string, ...string[]];
  cleanup: () => Promise<void>;
}> {
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));

  if (!contents.some(hasOverrideTags)) {
    return { files, cleanup: async () => {} };
  }

  if (!(await isComposePluginAvailable())) {
    throw new Error(
      'Compose file uses the "!reset"/"!override" merge tags, which require ' +
        "the Docker Compose v2 plugin ('docker compose') on the runner. " +
        "Install it (it ships with GitHub-hosted runners) or inline the override.",
    );
  }

  const merged = await mergeComposeFiles([...files]);
  const mergedFile = `docker-compose.merged.${randomUUID()}.yaml`;
  await writeFile(mergedFile, merged);

  return {
    files: [mergedFile],
    cleanup: async () => {
      await unlink(mergedFile);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compose.test.ts -t preMergeOverrides`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: pre-merge compose overrides via docker compose config"
```

---

### Task 4: Wire `preMergeOverrides` into the deploy flow

**Files:**
- Modify: `src/deployment.ts`
- Test: `tests/deployment.test.ts`

**Interfaces:**
- Consumes: `preMergeOverrides` (Task 3), returning `{ files, cleanup }`.
- Produces: `deploy` now pre-merges overrides before loading specs and always runs `cleanup` afterward.

- [ ] **Step 1: Write the failing test**

Add to `tests/deployment.test.ts` (it spies on `compose.*`, mocks `../src/engine.js`, and mocks `node:fs/promises`):

```ts
it("pre-merges override files and cleans up the temp file", async () => {
  const settings = defineSettings({
    envVarPrefix: "", keyInterpolation: false, manageVariables: false,
    monitor: false, monitorInterval: 0, monitorTimeout: 0, stack: "s",
    strictVariables: false, strictCompatibility: false,
    variables: new Map(), version: "1",
  });

  const cleanup = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue(["base.yaml", "override.yaml"]);
  const preMerge = vi
    .spyOn(compose, "preMergeOverrides")
    .mockResolvedValue({ files: ["merged.yaml"], cleanup });
  vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
    { services: { web: { image: "nginx" } } },
  ]);
  vi.spyOn(compose, "normalizeSpec").mockResolvedValue({
    services: { web: { image: "nginx" } },
  });
  vi.spyOn(compose, "interpolateSpec").mockReturnValue({
    services: { web: { image: "nginx" } },
  });
  vi.spyOn(variables, "pruneVariables").mockResolvedValue(undefined);

  await deploy(settings);

  expect(preMerge).toHaveBeenCalledWith(["base.yaml", "override.yaml"]);
  expect(compose.loadComposeSpecs).toHaveBeenCalledWith(["merged.yaml"], settings);
  expect(cleanup).toHaveBeenCalled();
});

it("still runs cleanup when a later step throws", async () => {
  const settings = defineSettings({
    envVarPrefix: "", keyInterpolation: false, manageVariables: false,
    monitor: false, monitorInterval: 0, monitorTimeout: 0, stack: "s",
    strictVariables: false, strictCompatibility: false,
    variables: new Map(), version: "1",
  });
  const cleanup = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(compose, "resolveComposeFiles").mockResolvedValue(["c.yaml"]);
  vi.spyOn(compose, "preMergeOverrides").mockResolvedValue({ files: ["c.yaml"], cleanup });
  vi.spyOn(compose, "loadComposeSpecs").mockRejectedValue(new Error("boom"));

  await expect(deploy(settings)).rejects.toThrow("boom");
  expect(cleanup).toHaveBeenCalled();
});
```

Note: `defineSettings` requires `strictCompatibility` (added in the reconciliation feature); include it in fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/deployment.test.ts -t "pre-merges override"`
Expected: FAIL — `compose.preMergeOverrides` not called / not a function.

- [ ] **Step 3: Implement**

Rewrite the body of `deploy` in `src/deployment.ts`, adding `preMergeOverrides` to the `./compose.js` import:

```ts
import {
  interpolateSpec,
  loadComposeSpecs,
  normalizeSpec,
  preMergeOverrides,
  resolveComposeFiles,
} from "./compose.js";
```

```ts
export async function deploy(settings: Readonly<Settings>) {
  const composeFiles = await resolveComposeFiles(settings);
  const { files: effectiveFiles, cleanup } = await preMergeOverrides(composeFiles);

  try {
    const composeSpecs = await loadComposeSpecs(effectiveFiles, settings);
    const composeSpec = await normalizeSpec(composeSpecs, settings);
    const finalSpec = interpolateSpec(composeSpec, settings);

    validateHealthChecks(finalSpec, settings);

    await deployStack(finalSpec, settings);

    if (settings.monitor) {
      await monitorDeployment(settings, finalSpec);
    }

    await pruneVariables(finalSpec, settings);

    return finalSpec;
  } finally {
    await cleanup();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/deployment.test.ts`
Expected: PASS (new tests + the existing "orderly deployment" test, which reads a tag-free spec via the mocked `readFile`, so `preMergeOverrides` passes the files through unchanged).

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/deployment.ts tests/deployment.test.ts
git commit -m "feat: pre-merge override tags in the deploy flow"
```

---

### Task 5: Docs, local-merge verification, pipeline, dist

**Files:**
- Modify: `README.md` (the "Compose → Swarm reconciliation" section, ~line 225)
- Regenerated: `dist/` (via `npm run package`)

- [ ] **Step 1: Verify `docker compose config` stays local under a remote host**

Run:
```bash
cd /tmp && printf 'services:\n  web:\n    image: nginx\n    ports: ["80:80"]\n' > b.yaml && \
printf 'services:\n  web:\n    ports: !override ["8080:80"]\n' > o.yaml && \
DOCKER_HOST=tcp://127.0.0.1:2375 timeout 15 docker compose -f b.yaml -f o.yaml config --no-interpolate
```
Expected: prints the merged config with only `8080` published, within a second — it does **not** hang trying to reach the unreachable `DOCKER_HOST`, confirming `config` is a local operation. If it hangs or errors on the connection, stop and report — the design would need env-scoping (unset `DOCKER_HOST` for the merge call).

- [ ] **Step 2: Document the requirement**

In `README.md`, under the "Compose → Swarm reconciliation" section, add a short paragraph (prose ≤ 80 chars/line):

```markdown
##### `!reset` / `!override` merge tags

Compose files that use the `!reset` and `!override` merge tags (to
control how base and override files combine) are merged with
`docker compose config` before deployment, so their semantics are
honored. This requires the Docker Compose v2 plugin on the runner
(included on GitHub-hosted runners). If the plugin is missing and these
tags are present, the action fails with a clear error rather than
mis-merging silently.
```

- [ ] **Step 3: Run the full pipeline**

Run: `npm run all`
Expected: format, lint, typecheck, all tests, and package pass; `dist/` regenerated. (A pre-existing flaky sleep-timing test in `tests/utils.test.ts` may need one rerun; do not modify it.)

- [ ] **Step 4: Commit**

```bash
git add README.md dist/ badges/coverage.svg
git commit -m "docs: document compose override-tag support; rebuild dist"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/compose-override-tags
gh pr create --title "feat: support !reset/!override compose merge tags" --body "<summary + link to the design doc and the empirical merge-engine findings>"
```

---

## Self-Review

**Spec coverage:**
- Detection (text scan, over-detection bias) → Task 1. ✓
- `docker compose config --no-interpolate` merge + plugin check → Task 2. ✓
- `preMergeOverrides` orchestration (no-tag passthrough, plugin-missing hard error, temp file + cleanup) → Task 3. ✓
- Wiring between resolve and load with `finally` cleanup → Task 4. ✓
- Error handling (clear plugin-missing message; compose stderr surfaced via `executeDockerCommand`'s throw) → Tasks 2–3. ✓
- Interaction note: local-only `docker compose config` under remote `DOCKER_HOST` → Task 5 Step 1 verification. ✓
- Testing (detection, wrappers, orchestration, wiring, integration) → Tasks 1–4 unit tests; the guarded end-to-end integration test from the spec is covered pragmatically by Task 5 Step 1's manual verification (kept out of the suite to avoid a Docker dependency in CI unit tests). ✓
- Docs → Task 5. ✓

**Placeholder scan:** No TBD/TODO. Every code step has complete code. The only free-text is the PR body (Task 5 Step 5) and README prose, which are inherently narrative. ✓

**Type consistency:** `preMergeOverrides(files): Promise<{ files; cleanup }>` is defined in Task 3 and consumed identically in Task 4. `mergeComposeFiles(files: string[])` (Task 2) is called with `[...files]` in Task 3. `isComposePluginAvailable(): Promise<boolean>` used consistently. `hasOverrideTags(content: string): boolean` (Task 1) used in Task 3. Engine functions imported from `"./engine"` (no extension) to match the existing import in `compose.ts`. ✓
