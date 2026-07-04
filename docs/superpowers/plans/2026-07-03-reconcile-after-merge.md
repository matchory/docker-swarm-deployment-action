# Reconcile After Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `reconcileSwarmCompatibility` on the tag-free merged spec (after `docker compose config`) instead of per-file before the merge, so `!reset`/`!override` tags on reconciled keys just work and the guard can be deleted.

**Architecture:** Split `reconcileSpec` into a per-file **prepare** step (strip name, force version, require services, convert `content:`/`environment:` secrets to files) that the load phase runs, and move `reconcileSwarmCompatibility` into `normalizeSpec`, which becomes the single owner of merge+reconcile ordering via two helpers: `reconcileThenMerge` (non-tag path — reconcile each, then `docker stack config`) and `mergeThenReconcile` (tag path — `docker compose config` merge, reconcile the merged spec, then `docker stack config`). The guard `assertMergeableTagUsage` and its supporting exports are removed.

**Tech Stack:** TypeScript (strict, ESM), js-yaml v5, `@actions/exec`, `@actions/core`, Vitest, Biome. Node 24.

## Global Constraints

- Runtime: Node 24, ESM (`"type": "module"`). Intra-repo imports use the `.js` extension **except** imports from `./engine`, which `compose.ts` writes without an extension — match the file you edit.
- Tooling: **Biome** (double quotes, semicolons); **Vitest**. Run `npm run format:write` before each commit; `npm run all` before pushing (rebuilds committed `dist/`). No new npm dependencies.
- Non-tag path runtime behavior must stay unchanged. The secret transform (`processVariable`) still runs pre-merge for both paths.
- Merge via `docker compose config --no-interpolate` (honors the tags; preserves `${VAR}`) only when tags are present. Plugin-missing while tags are present is a **hard error**, never a silent fallback.
- All Docker calls go through the private `executeDockerCommand` in `engine.ts`.
- `js-yaml` mapping `represent` returns a `Map`; scalar returns the source string; sequence returns the array (already implemented — do not touch `override-tags.ts` tag definitions).
- `compose.test.ts` mocks `js-yaml` and `../src/variables.js` wholesale; `merge.test.ts` and any real-tool integration test must **not** mock them.
- Empty-services error message, copied verbatim:
  `All services were removed during reconciliation because they use features Docker Swarm cannot run (e.g. provider services); nothing to deploy.`
- Plugin-missing error message, copied verbatim:
  `Compose file uses the "!reset"/"!override" merge tags, which require the Docker Compose v2 plugin ('docker compose') on the runner. Install it (it ships with GitHub-hosted runners) or inline the override.`

## File Structure

- **Modify** `src/compose.ts` — `loadComposeSpec` returns `{ spec, baseDir }`; rename `reconcileSpec` → `prepareSpec` (drop reconcile + guard); rewrite `normalizeSpec` with the two helpers.
- **Modify** `src/override-tags.ts` — delete `assertMergeableTagUsage` and the `./reconcile.js` import.
- **Modify** `src/reconcile.ts` — delete the `reconciledServiceKeys` and `deployFoldingKeys` exports.
- **Modify** `tests/compose.test.ts` — wrap specs as `{ spec, baseDir }`; rename `reconcileSpec` calls; relocate the empty-check test to `normalizeSpec`; delete the redundant reconcile test + guard test; update the tag-path `normalizeSpec` tests.
- **Modify** `tests/merge.test.ts` — destructure `{ spec }`; assert the prepared (un-reconciled) shape.
- **Modify** `tests/deployment.test.ts` — `loadComposeSpecs` mock returns `{ spec, baseDir }[]`.
- **Modify** `tests/override-tags.test.ts` — delete the `assertMergeableTagUsage` suite.
- **Create** `tests/reconcile-after-merge.integration.test.ts` — real-tool DoD proof (guarded on Docker/Compose availability).
- **Modify** `README.md` — note reconcile runs after the merge for tag files.

---

### Task 1: `loadComposeSpec` returns `{ spec, baseDir }` (plumbing only)

Pure shape change. `reconcileSpec` still reconciles per file (unchanged); we only wrap its result and teach `normalizeSpec` to read `.spec`. Keeps the build green before the behavior move in Task 2.

**Files:**
- Modify: `src/compose.ts` (`loadComposeSpec` ~line 170; `normalizeSpec` ~line 277)
- Test: `tests/compose.test.ts`, `tests/merge.test.ts`, `tests/deployment.test.ts`

**Interfaces:**
- Consumes: `reconcileSpec` (unchanged), `containsOverrideTag`, engine helpers.
- Produces:
  - `loadComposeSpecs(files, settings): Promise<Array<{ spec: ComposeSpec; baseDir: string }>>`
  - `normalizeSpec(prepared: Array<{ spec: ComposeSpec; baseDir: string }>, settings): Promise<ComposeSpec>`

- [ ] **Step 1: Update the `loadComposeSpecs` shape tests**

In `tests/compose.test.ts`, the "Spec Loading" block (~line 269) asserts `resolves.toEqual([composeSpec])`. Change the passing test to expect the wrapped shape:

```ts
it("should load and reconcile the compose specification", async () => {
  const composeSpec = defineComposeSpec({
    version: "3.8",
    services: {
      web: {
        image: "nginx:latest",
      },
    },
  });
  vi.spyOn(utils, "exists").mockResolvedValue(true);
  vi.mocked(exec).mockResolvedValue(0);
  vi.spyOn(yaml, "load").mockReturnValue(composeSpec);

  await expect(
    loadComposeSpecs(["docker-compose.yaml"], settings),
  ).resolves.toEqual([{ spec: composeSpec, baseDir: "." }]);
});
```

(The services-missing test just below it still `rejects.toThrowError()` — leave it.)

- [ ] **Step 2: Update the `normalizeSpec` non-tag test to the wrapped input**

In `tests/compose.test.ts`, "Spec Normalization and Merging" → "should normalize and merge the spec" (~line 535), wrap each input spec:

```ts
const inputSpecs = [
  {
    spec: { version: "3.8", services: { web: { image: "nginx:latest" } } },
    baseDir: ".",
  },
  {
    spec: { version: "3.8", services: { db: { image: "mysql:latest" } } },
    baseDir: ".",
  },
];
```

Leave the `outputSpec`, the `yaml.load` mock, the `exec` argv assertion, and the `yaml.load` call assertion unchanged.

- [ ] **Step 3: Update the tag-path `normalizeSpec` tests to the wrapped input**

In `tests/compose.test.ts`, "normalizeSpec override-tag merge" (~line 635), wrap the `specs` array in every test (three tests). For each, change the element from `{ services: {...} }` to `{ spec: { services: {...} }, baseDir: "." }`. Example for the first test:

```ts
const specs = [
  {
    spec: {
      services: {
        web: {
          image: "nginx",
          ports: new Tagged("!override", "sequence", []),
        },
      },
    },
    baseDir: ".",
  },
] as unknown as Parameters<typeof normalizeSpec>[0];
```

Apply the same wrapping to the "throws when tags are present but the compose plugin is missing" and "uses docker stack config directly when no tags are present" tests. Leave their assertions unchanged.

- [ ] **Step 4: Update `merge.test.ts` destructuring**

In `tests/merge.test.ts` (~line 46), change:

```ts
const [{ spec }] = await loadComposeSpecs(["compose.yaml"], settings);
```

Leave the `spec.services.api` / `spec.services.worker` assertions unchanged for now (reconcile still runs in the load phase in this task).

- [ ] **Step 5: Update `deployment.test.ts` mock shape**

In `tests/deployment.test.ts`, both `loadComposeSpecs` mocks (~line 54 and ~line 167) return a bare-spec array. Wrap them. For the first (~line 54):

```ts
vi.spyOn(compose, "loadComposeSpecs").mockResolvedValue([
  {
    spec: {
      name: "foo",
      services: { web: { image: "nginx:latest" } },
    },
    baseDir: ".",
  },
]);
```

And update the matching `normalizeSpec` call assertion (~line 90) to expect the wrapped array:

```ts
expect(compose.normalizeSpec).toHaveBeenCalledWith(
  [
    {
      spec: {
        name: "foo",
        services: { web: { image: "nginx:latest" } },
      },
      baseDir: ".",
    },
  ],
  settings,
);
```

Do the same wrapping for the second `loadComposeSpecs` mock (~line 167); it has no `normalizeSpec` call-args assertion to update, but check the file and update any that exist.

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/compose.test.ts tests/merge.test.ts tests/deployment.test.ts`
Expected: FAIL — `loadComposeSpecs` still returns bare specs; `normalizeSpec` reads specs directly.

- [ ] **Step 7: Implement the shape change in `compose.ts`**

Change `loadComposeSpec` (~line 170) to wrap:

```ts
async function loadComposeSpec(filename: string, settings: Settings) {
  const content = await readFile(filename, "utf8");
  const parsedContent = load(content, {
    filename,
    schema: composeSchema,
  }) as ComposeSpec;

  const spec = await reconcileSpec(parsedContent, settings, filename);

  return { spec, baseDir: dirname(filename) };
}
```

In `normalizeSpec` (~line 277), change the signature and the two spots that read the specs. Replace the `composeSpecs.map(...)` generation and the `composeSpecs.some(containsOverrideTag)` check:

```ts
export async function normalizeSpec(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  const generated = await Promise.all(
    prepared.map(async ({ spec }) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec, { schema: composeSchema }));
      return file;
    }),
  );

  const tempFiles = [...generated];

  try {
    let filesToNormalize = generated;

    if (prepared.some((item) => containsOverrideTag(item.spec))) {
      if (!(await isComposePluginAvailable())) {
        throw new Error(
          'Compose file uses the "!reset"/"!override" merge tags, which ' +
            "require the Docker Compose v2 plugin ('docker compose') on the " +
            "runner. Install it (it ships with GitHub-hosted runners) or " +
            "inline the override.",
        );
      }

      const merged = await mergeComposeFiles(generated);
      const mergedFile = `docker-compose.merged.${randomUUID()}.yaml`;
      await writeFile(mergedFile, merged);
      tempFiles.push(mergedFile);
      filesToNormalize = [mergedFile];
    }

    const spec = await normalizeStackSpecification(
      filesToNormalize,
      settings,
      true,
    );

    if (!spec?.services || Object.keys(spec.services).length === 0) {
      throw new Error("Invalid stack specification: Missing services section");
    }

    return spec;
  } finally {
    await Promise.all(tempFiles.map((path) => unlink(path)));
  }
}
```

Update the JSDoc `@param composeSpecs` above `normalizeSpec` to `@param prepared` describing `{ spec, baseDir }`.

Update the call site in `src/deployment.ts` — none needed: `deploy()` already passes the `loadComposeSpecs` result straight to `normalizeSpec`; only the type flows through.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/compose.test.ts tests/merge.test.ts tests/deployment.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
npm run typecheck
npm run format:write
git add src/compose.ts tests/compose.test.ts tests/merge.test.ts tests/deployment.test.ts
git commit -m "refactor: loadComposeSpec returns { spec, baseDir }"
```

---

### Task 2: Move reconcile into `normalizeSpec`; remove the guard call

Rename `reconcileSpec` → `prepareSpec`, dropping `reconcileSwarmCompatibility`, the empty-check, and the `assertMergeableTagUsage` call. Move reconcile + empty-check into `normalizeSpec` via two helpers. After this task the three previously-rejected cases work (verified fully by Task 4's real-tool test).

**Files:**
- Modify: `src/compose.ts`
- Test: `tests/compose.test.ts`, `tests/merge.test.ts`

**Interfaces:**
- Consumes: `reconcileSwarmCompatibility(spec, settings, baseDir?)` from `./reconcile.js`; `containsOverrideTag`, `isComposePluginAvailable`, `mergeComposeFiles`, `normalizeStackSpecification`.
- Produces:
  - `prepareSpec(composeSpec: ComposeSpec, settings: Settings): Promise<ComposeSpec>` — name/version/services + `processVariable`; no reconcile, no guard.
  - `normalizeSpec` reconciles each spec (non-tag) or the merged spec (tag) internally.

- [ ] **Step 1: Retarget the "removes all services" test to `normalizeSpec`**

In `tests/compose.test.ts`, "Schema Reconciliation", the "throws a clear error when reconciliation removes all services" test (~line 517) currently calls `reconcileSpec`. Replace it with a `normalizeSpec` (non-tag path) test that drives reconcile through the new home:

```ts
it("throws when reconciliation removes all services (non-tag path)", async () => {
  await expect(
    normalizeSpec(
      [
        {
          spec: defineComposeSpec({
            services: { ai: { provider: { type: "model-runner" } } },
          }),
          baseDir: ".",
        },
      ],
      { ...settings, manageVariables: false, strictCompatibility: false },
    ),
  ).rejects.toThrow(/All services were removed during reconciliation/);
});
```

- [ ] **Step 2: Delete the redundant reconcile test and the guard test**

In `tests/compose.test.ts`, "Schema Reconciliation":
- Delete the "reconciles modern compose keys into swarm-compatible form" test (~line 490) — this behavior is covered by `tests/reconcile.test.ts` and reconcile no longer runs inside the per-file step.
- Delete the "rejects a merge tag placed on a reconciled key" test (~line 373).

- [ ] **Step 3: Rename the remaining `reconcileSpec` calls to `prepareSpec`**

In `tests/compose.test.ts`:
- Update the import (~line 11): replace `reconcileSpec` with `prepareSpec`.
- In "Schema Reconciliation", the surviving tests exercise prepare behavior: name removal (~line 299), version add (~line 319), version preserve (~line 338), services missing (~line 358), services empty (~line 364), process secrets/configs (~line 391), skip when disabled (~line 443). Change every `reconcileSpec(` in these tests to `prepareSpec(`. Their expected values are unchanged (none of them use modern keys, so reconcile was a no-op anyway).

- [ ] **Step 4: Update `merge.test.ts` to the un-reconciled prepared shape**

In `tests/merge.test.ts` (~line 48), reconcile no longer runs during load, so the anchored `restart: unless-stopped` survives untranslated. Update the assertions:

```ts
const [{ spec }] = await loadComposeSpecs(["compose.yaml"], settings);

expect(spec.services.api).toEqual({
  restart: "unless-stopped",
  networks: ["web"],
  image: "api:latest",
});
expect(spec.services.worker).toEqual({
  restart: "unless-stopped",
  networks: ["web"],
  image: "worker:latest",
});
// The literal merge key must never survive into the resolved spec.
expect(spec.services.api).not.toHaveProperty("<<");
```

- [ ] **Step 5: Update the tag-path `normalizeSpec` test to parse + reconcile the merged spec**

In `tests/compose.test.ts`, "normalizeSpec override-tag merge" → "merges via docker compose then normalizes when tags are present" (~line 638). The new tag path parses the merged YAML (`yaml.load`) and reconciles it before writing. Add a `yaml.load` mock and a reconcile spy. Rewrite the test body:

```ts
it("merges via docker compose then reconciles + normalizes when tags are present", async () => {
  vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
  vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue(
    "services:\n  web:\n    image: nginx\n    restart: always\n",
  );
  // The merged, tag-free spec that `docker compose config` produced.
  vi.spyOn(yaml, "load").mockReturnValue({
    services: { web: { image: "nginx", restart: "always" } },
  });
  const reconcileSpy = vi.spyOn(reconcile, "reconcileSwarmCompatibility");
  const normalize = vi
    .spyOn(engine, "normalizeStackSpecification")
    .mockResolvedValue({ services: { web: { image: "nginx" } } });

  const specs = [
    {
      spec: {
        services: {
          web: {
            image: "nginx",
            ports: new Tagged("!override", "sequence", []),
          },
        },
      },
      baseDir: ".",
    },
  ] as unknown as Parameters<typeof normalizeSpec>[0];

  await normalizeSpec(specs, settings);

  expect(engine.mergeComposeFiles).toHaveBeenCalled();
  // reconcile runs on the tag-free merged spec, translating restart.
  expect(reconcileSpy).toHaveBeenCalledWith(
    { services: { web: { deploy: { restart_policy: { condition: "any" } } } } },
    settings,
  );
  // normalize runs on a single merged file.
  expect(normalize).toHaveBeenCalledWith(
    [expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/)],
    settings,
    true,
  );
  expect(unlink).toHaveBeenCalledWith(
    expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/),
  );
});
```

Add the reconcile module import at the top of `tests/compose.test.ts` (near the other imports, ~line 15):

```ts
import * as reconcile from "../src/reconcile.js";
```

Note: the `reconcileSpy` call-arg assertion expects the object **after** in-place reconciliation (spies call through by default), so `restart: "always"` has become `deploy.restart_policy.condition: "any"`.

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/compose.test.ts tests/merge.test.ts`
Expected: FAIL — `prepareSpec` not exported; `normalizeSpec` does not yet reconcile.

- [ ] **Step 7: Implement `prepareSpec` + the two helpers in `compose.ts`**

Rename `reconcileSpec` (~line 194) to `prepareSpec`, removing the guard call, the `reconcileSwarmCompatibility` call, the empty-check, and the now-unused `filename` param and `dirname` usage inside it:

```ts
/**
 * Prepare a parsed Compose spec for merging: normalize top-level shape and
 * convert `content:`/`environment:` secrets and configs to files. This is the
 * only transform that must run before either Docker merge tool sees the spec.
 * Swarm reconciliation runs later, in `normalizeSpec`, on the merged output.
 */
export async function prepareSpec(composeSpec: ComposeSpec, settings: Settings) {
  if (composeSpec.name) {
    delete composeSpec.name;
  }

  if (!composeSpec.version) {
    composeSpec.version = schemaVersion;
  }

  if (!composeSpec.services || Object.keys(composeSpec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }

  if (settings.manageVariables) {
    if (composeSpec.secrets) {
      core.startGroup("Processing secrets");

      for (const [name, entry] of Object.entries(composeSpec.secrets)) {
        composeSpec.secrets[name] = await processVariable(name, entry, settings);
      }

      core.endGroup();
    }

    if (composeSpec.configs) {
      core.startGroup("Processing configs");

      for (const [name, entry] of Object.entries(composeSpec.configs)) {
        composeSpec.configs[name] = await processVariable(name, entry, settings);
      }

      core.endGroup();
    }
  }

  return composeSpec;
}
```

Update `loadComposeSpec` to call `prepareSpec` (it no longer needs to pass `filename` into the prepare step; `baseDir` comes from `dirname(filename)` for `normalizeSpec`):

```ts
async function loadComposeSpec(filename: string, settings: Settings) {
  const content = await readFile(filename, "utf8");
  const parsedContent = load(content, {
    filename,
    schema: composeSchema,
  }) as ComposeSpec;

  const spec = await prepareSpec(parsedContent, settings);

  return { spec, baseDir: dirname(filename) };
}
```

Rewrite `normalizeSpec` to own merge + reconcile via two helpers:

```ts
export async function normalizeSpec(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  const spec = prepared.some((item) => containsOverrideTag(item.spec))
    ? await mergeThenReconcile(prepared, settings)
    : await reconcileThenMerge(prepared, settings);

  if (!spec?.services || Object.keys(spec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }

  return spec;
}

// Non-tag path: reconcile each spec (with its own base directory), then let
// `docker stack config` merge and normalize them — the pre-rework flow.
async function reconcileThenMerge(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  for (const { spec, baseDir } of prepared) {
    await reconcileSwarmCompatibility(spec, settings, baseDir);
    assertServicesRemain(spec);
  }

  const files = await Promise.all(
    prepared.map(async ({ spec }) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec, { schema: composeSchema }));
      return file;
    }),
  );

  try {
    return await normalizeStackSpecification(files, settings, true);
  } finally {
    await Promise.all(files.map((path) => unlink(path)));
  }
}

// Tag path: merge with `docker compose config` (which honors the
// !reset/!override tags and emits a tag-free spec), reconcile the merged
// spec for Swarm, then normalize via `docker stack config`.
async function mergeThenReconcile(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  if (!(await isComposePluginAvailable())) {
    throw new Error(
      'Compose file uses the "!reset"/"!override" merge tags, which ' +
        "require the Docker Compose v2 plugin ('docker compose') on the " +
        "runner. Install it (it ships with GitHub-hosted runners) or " +
        "inline the override.",
    );
  }

  const tempFiles = await Promise.all(
    prepared.map(async ({ spec }) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec, { schema: composeSchema }));
      return file;
    }),
  );

  try {
    const merged = await mergeComposeFiles(tempFiles);
    const mergedSpec = load(merged, {
      filename: "docker-compose.merged.yaml",
      json: true,
    }) as ComposeSpec;

    await reconcileSwarmCompatibility(mergedSpec, settings);
    assertServicesRemain(mergedSpec);

    const mergedFile = `docker-compose.merged.${randomUUID()}.yaml`;
    await writeFile(mergedFile, dump(mergedSpec, { schema: composeSchema }));
    tempFiles.push(mergedFile);

    return await normalizeStackSpecification([mergedFile], settings, true);
  } finally {
    await Promise.all(tempFiles.map((path) => unlink(path)));
  }
}

function assertServicesRemain(spec: ComposeSpec) {
  if (Object.keys(spec.services).length === 0) {
    throw new Error(
      "All services were removed during reconciliation because they use " +
        "features Docker Swarm cannot run (e.g. provider services); " +
        "nothing to deploy.",
    );
  }
}
```

Remove the now-unused `assertMergeableTagUsage` from the `./override-tags.js` import in `compose.ts` (keep `containsOverrideTag` and `overrideTagDefinitions`):

```ts
import {
  containsOverrideTag,
  overrideTagDefinitions,
} from "./override-tags.js";
```

`reconcileSwarmCompatibility` is already imported from `./reconcile.js`; `dirname` is already imported from `node:path`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/compose.test.ts tests/merge.test.ts tests/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
npm run typecheck
npm run format:write
git add src/compose.ts tests/compose.test.ts tests/merge.test.ts
git commit -m "feat: reconcile the tag-free merged spec after docker compose merge"
```

---

### Task 3: Delete the dead guard and its supporting exports

`normalizeSpec` no longer lets a `Tagged` carrier reach reconcile, so the guard is unreachable. Remove it and the two exports that existed only to feed it.

**Files:**
- Modify: `src/override-tags.ts` (delete `assertMergeableTagUsage` + the `./reconcile.js` import)
- Modify: `src/reconcile.ts` (delete `reconciledServiceKeys`, `deployFoldingKeys`)
- Test: `tests/override-tags.test.ts` (delete the guard suite)

**Interfaces:**
- Produces: `override-tags.ts` exports only `Tagged`, `overrideTagDefinitions`, `containsOverrideTag`.

- [ ] **Step 1: Delete the guard test suite**

In `tests/override-tags.test.ts`, delete the entire `describe("assertMergeableTagUsage", …)` block (~line 62 to its close, ~line 133) and remove `assertMergeableTagUsage` from the import at the top (~line 5). Keep the round-trip and `containsOverrideTag` suites.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/override-tags.test.ts`
Expected: FAIL — the deleted block referenced `assertMergeableTagUsage`; the import no longer resolves it, or a stale reference remains. (If it unexpectedly passes, the deletion is already consistent — proceed.)

- [ ] **Step 3: Delete the guard from `override-tags.ts`**

In `src/override-tags.ts`:
- Delete the import `import { deployFoldingKeys, reconciledServiceKeys } from "./reconcile.js";` (~line 7).
- Delete the entire `assertMergeableTagUsage` function and its doc comment (~line 81 to end of file).

Keep `Tagged`, `isTagged`, `overrideTag`, `overrideTagDefinitions`, `containsOverrideTag`.

- [ ] **Step 4: Delete the supporting exports from `reconcile.ts`**

In `src/reconcile.ts`, delete the `reconciledServiceKeys` export (~line 211–222) and the `deployFoldingKeys` export (~line 224–232), including their doc comments. `resourceTranslations` (above them) stays — it is still used by `translateResources`.

- [ ] **Step 5: Run the full suite + typecheck to verify nothing else referenced them**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no unresolved references.

- [ ] **Step 6: Lint (unused-import guard) + commit**

```bash
npm run lint
npm run format:write
git add src/override-tags.ts src/reconcile.ts tests/override-tags.test.ts
git commit -m "refactor: remove now-unreachable merge-tag guard"
```

---

### Task 4: Real-tool DoD proof, docs, dist

Prove the three previously-rejected cases with the real `docker compose config` merge + real reconcile, document the ordering, and rebuild `dist/`.

**Files:**
- Create: `tests/reconcile-after-merge.integration.test.ts`
- Modify: `README.md`
- Regenerated: `dist/`

**Interfaces:**
- Consumes: `mergeComposeFiles` (`src/engine.js`), `reconcileSwarmCompatibility` (`src/reconcile.js`), real `docker compose`.

- [ ] **Step 1: Write the integration test (real tools; no mocks)**

Create `tests/reconcile-after-merge.integration.test.ts`:

```ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeComposeFiles } from "../src/engine.js";
import { reconcileSwarmCompatibility } from "../src/reconcile.js";
import type { ComposeSpec } from "../src/compose.js";

function composeAvailable(): boolean {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const settings = { strictCompatibility: false };
const suite = composeAvailable() ? describe : describe.skip;

// Merge two compose files with the real `docker compose config`, then run the
// action's real Swarm reconciliation on the tag-free merged output.
async function mergeAndReconcile(
  dir: string,
  base: string,
  over: string,
): Promise<ComposeSpec> {
  const merged = await mergeComposeFiles([join(dir, base), join(dir, over)]);
  const spec = load(merged, { json: true }) as ComposeSpec;
  await reconcileSwarmCompatibility(spec, settings);
  return spec;
}

suite("reconcile after merge (real docker compose)", () => {
  let dir: string;
  let savedWorkspace: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-after-merge-"));
    // reconcile confines label_file to GITHUB_WORKSPACE; point it at the temp
    // dir so the absolute path compose emits is accepted.
    savedWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = dir;
  });

  afterAll(() => {
    if (savedWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedWorkspace;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("deploy:!override + restart: both survive into deploy", async () => {
    writeFileSync(
      join(dir, "base.yaml"),
      "services:\n  web:\n    image: nginx\n    restart: always\n" +
        "    deploy:\n      replicas: 1\n",
    );
    writeFileSync(
      join(dir, "over.yaml"),
      "services:\n  web:\n    deploy: !override\n      replicas: 3\n",
    );

    const spec = await mergeAndReconcile(dir, "base.yaml", "over.yaml");

    const web = spec.services.web as Record<string, any>;
    expect(web.deploy.replicas).toBe(3);
    expect(web.deploy.restart_policy).toEqual({ condition: "any" });
    expect(web).not.toHaveProperty("restart");
  });

  it("labels:!override + label_file: labels reconcile correctly", async () => {
    writeFileSync(join(dir, "labels.env"), "FROM_FILE=filevalue\n");
    writeFileSync(
      join(dir, "base.yaml"),
      "services:\n  web:\n    image: nginx\n" +
        "    label_file:\n      - ./labels.env\n" +
        "    labels:\n      base: baselabel\n",
    );
    writeFileSync(
      join(dir, "over.yaml"),
      "services:\n  web:\n    labels: !override\n      only: this\n",
    );

    const spec = await mergeAndReconcile(dir, "base.yaml", "over.yaml");

    const web = spec.services.web as Record<string, any>;
    // !override replaced the labels map; label_file entries merge in under it.
    expect(web.labels).toEqual({ FROM_FILE: "filevalue", only: "this" });
    expect(web).not.toHaveProperty("label_file");
  });

  it("depends_on:!override reconciles to a list", async () => {
    writeFileSync(
      join(dir, "base.yaml"),
      "services:\n  web:\n    image: nginx\n" +
        "    depends_on:\n      - db\n      - cache\n" +
        "  db:\n    image: postgres\n  cache:\n    image: redis\n",
    );
    writeFileSync(
      join(dir, "over.yaml"),
      "services:\n  web:\n    depends_on: !override\n      - db\n",
    );

    const spec = await mergeAndReconcile(dir, "base.yaml", "over.yaml");

    const web = spec.services.web as Record<string, any>;
    expect(web.depends_on).toEqual(["db"]);
  });

  it("preserves an explicit secret name and labels through the merge", async () => {
    writeFileSync(join(dir, "secret.txt"), "secretval\n");
    writeFileSync(
      join(dir, "base.yaml"),
      "services:\n  web:\n    image: nginx\n" +
        "    secrets:\n      - my_secret\n" +
        "secrets:\n  my_secret:\n    file: ./secret.txt\n" +
        "    name: myapp-my_secret-abc1234\n" +
        "    labels:\n      com.matchory.deployment.stack: myapp\n",
    );
    writeFileSync(
      join(dir, "over.yaml"),
      'services:\n  web:\n    ports: !override\n      - "8080:80"\n',
    );

    const merged = await mergeComposeFiles([
      join(dir, "base.yaml"),
      join(dir, "over.yaml"),
    ]);
    const spec = load(merged, { json: true }) as ComposeSpec;

    const secret = (spec.secrets as Record<string, any>).my_secret;
    expect(secret.name).toBe("myapp-my_secret-abc1234");
    expect(secret.labels["com.matchory.deployment.stack"]).toBe("myapp");
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/reconcile-after-merge.integration.test.ts`
Expected: PASS on a machine with `docker compose` (all four cases green). On a machine without it, the suite is skipped — that is acceptable, but run it at least once on a Docker-capable machine to confirm green.

- [ ] **Step 3: Document the ordering in `README.md`**

Find the `##### `!reset` / `!override` merge tags` subsection added by PR #154 (search `README.md` for `!override`). Replace its body so it states reconcile runs after the merge (prose ≤ 80 chars/line):

```markdown
##### `!reset` / `!override` merge tags

Compose files may use the standard `!reset` and `!override` merge tags to
control how base and override files combine. When present, the action
merges the files with `docker compose config` (which honors the tags),
then reconciles the tag-free merged result for Swarm — so these tags work
even on keys the action rewrites (`restart`, `mem_limit`, `depends_on`,
`label_file`, and `deploy`). Only the secret/config `content:` transform
runs before the merge. This requires the Docker Compose v2 plugin on the
runner (included on GitHub-hosted runners); if it is missing and these
tags are used, the action fails with a clear error rather than merging
incorrectly.
```

If PR #154's subsection is not present in `README.md` (docs commit not yet on this branch), add this subsection under the "Compose → Swarm reconciliation" section instead.

- [ ] **Step 4: Run the full pipeline**

Run: `npm run all`
Expected: format, lint, typecheck, all tests, and package pass; `dist/` regenerated. (A pre-existing flaky sleep test in `tests/utils.test.ts` may need one rerun; do not modify it.)

- [ ] **Step 5: Commit**

```bash
git add tests/reconcile-after-merge.integration.test.ts README.md dist/ badges/coverage.svg
git commit -m "test: real-tool proof of reconcile-after-merge; docs; rebuild dist"
```

---

## Self-Review

**Spec coverage:**
- Prepare/reconcile split (load prepares; `normalizeSpec` reconciles) → Tasks 1–2. ✓
- Tag path merge → reconcile(merged) → stack config; non-tag path reconcile each → stack config → Task 2 (`mergeThenReconcile` / `reconcileThenMerge`). ✓
- `baseDir` threaded for non-tag; default (`process.cwd()`) for tag (label_file absolutized) → Task 2 helpers. ✓
- Empty-check relocated adjacent to reconcile → Task 2 (`assertServicesRemain`, both helpers). ✓
- Guard + `reconciledServiceKeys`/`deployFoldingKeys` removed → Task 3. ✓
- Secret transform stays pre-merge (`prepareSpec` runs `processVariable`) → Task 2. ✓
- Plugin-missing hard error preserved verbatim → Task 1 (interim) + Task 2 (`mergeThenReconcile`). ✓
- Real-tool proof of the three DoD cases + secret name/label survival → Task 4. ✓
- Non-tag runtime unchanged (reconcile each → stack config, same argv) → Task 1/2 tests assert the `docker stack config` argv. ✓
- Docs + dist → Task 4. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every command shows expected result. README prose is inherently narrative. ✓

**Type consistency:** `loadComposeSpecs` → `Array<{ spec: ComposeSpec; baseDir: string }>` used identically in Tasks 1, 2, and the tests. `prepareSpec(composeSpec, settings)` (Task 2) matches its callers. `reconcileSwarmCompatibility(spec, settings, baseDir?)` called with 3 args (non-tag) and 2 args (tag) — matches its existing signature (`baseDir` defaults to `process.cwd()`). `assertServicesRemain(spec)` defined once, called in both helpers. `normalizeSpec(prepared, settings)` signature consistent across `deployment.ts`, tests, and helpers. ✓
