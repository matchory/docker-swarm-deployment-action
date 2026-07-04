# Compose `!reset` / `!override` Merge-Tag Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support the standard Compose `!reset`/`!override` merge tags by registering them as round-tripping js-yaml tags (so they survive the action's transform untouched) and merging tag-bearing specs through `docker compose config` — preserving the transform-first invariant.

**Architecture:** A new `src/override-tags.ts` defines a `Tagged` carrier plus js-yaml tag definitions that load `!reset`/`!override` into carriers and re-emit them on `dump`. `compose.ts` adds these to its parse schema; `reconcileSpec` runs unchanged (tags sit on keys it doesn't touch); `normalizeSpec` detects carriers and, only then, merges via `docker compose config --no-interpolate` before the usual `docker stack config` normalization. A guard rejects tags placed on the few keys reconciliation rewrites.

**Tech Stack:** TypeScript (strict, ESM), js-yaml v5, `@actions/exec`, `@actions/core`, Vitest, Biome. Node 24.

## Global Constraints

- Runtime: Node 24, ESM (`"type": "module"`). Intra-repo imports use the `.js` extension **except** imports from `./engine`, which the existing `compose.ts` writes without an extension — match the file you edit.
- Tooling: **Biome** (double quotes, semicolons); **Vitest**. Run `npm run format:write` before each commit; `npm run all` before pushing (rebuilds committed `dist/`). No new npm dependencies.
- Only the two **standard** Compose tags — `!reset`, `!override`. No invented tags, no generic passthrough.
- **Transform-first invariant:** `reconcileSpec` (reconcile modern→swarm + convert `content:`/`environment:` secrets to files) must run before any Docker tool. Do not reorder it.
- Merge via `docker compose config --no-interpolate` (honors the tags; preserves `${VAR}` for the action's own `interpolateSpec`). Only when tags are present.
- Plugin-missing while tags are present is a **hard error**, never a silent fallback to `docker stack config`.
- All Docker calls go through the private `executeDockerCommand(args, opts)` in `engine.ts`; `docker compose …` is args beginning with `"compose"`.
- `js-yaml` mapping `represent` must return a `Map`; scalar `represent` returns the source string; sequence returns the array (verified).
- `compose.test.ts` mocks `js-yaml` wholesale — real round-trip tests belong in a separate file that does **not** mock it (mirror `tests/merge.test.ts`).

## File Structure

- **Create** `src/override-tags.ts` — `Tagged`, `overrideTagDefinitions` (via an `overrideTag(name)` helper), `containsOverrideTag`, `tagSensitiveServiceKeys`, `assertMergeableTagUsage`.
- **Create** `tests/override-tags.test.ts` — real-js-yaml round-trip + detector + guard tests.
- **Modify** `src/engine.ts` — `isComposePluginAvailable`, `mergeComposeFiles`.
- **Modify** `src/compose.ts` — extend + export `composeSchema`; call the guard in `reconcileSpec`; branch `normalizeSpec`.
- **Modify** `tests/engine.test.ts`, `tests/compose.test.ts`.
- **Modify** `README.md` — document the tag support + plugin requirement.

---

### Task 1: `override-tags.ts` — carrier, tag definitions, detector

**Files:**
- Create: `src/override-tags.ts`
- Create: `tests/override-tags.test.ts`

**Interfaces:**
- Produces:
  - `class Tagged { readonly tag: string; readonly kind: "scalar" | "sequence" | "mapping"; readonly value: unknown }`
  - `overrideTagDefinitions: TagDefinition[]` — js-yaml definitions for `!reset` and `!override` across all three node kinds.
  - `containsOverrideTag(value: unknown): boolean` — deep-scans for a `Tagged`.

- [ ] **Step 1: Write the failing test**

Create `tests/override-tags.test.ts` (no js-yaml mock — real round-trip):

```ts
import { CORE_SCHEMA, dump, load, mergeTag } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  containsOverrideTag,
  overrideTagDefinitions,
  Tagged,
} from "../src/override-tags.js";

const schema = CORE_SCHEMA.withTags(mergeTag, ...overrideTagDefinitions);

describe("override tag round-trip", () => {
  it("preserves scalar, sequence, and mapping tags through load→dump", () => {
    const yaml = [
      "services:",
      "  web:",
      "    ports: !override",
      '      - "8080:80"',
      "    environment: !reset null",
      "    labels: !override",
      '      com.x: "y"',
      "",
    ].join("\n");

    const doc = load(yaml, { schema }) as {
      services: { web: { ports: unknown; deploy?: unknown } };
    };
    expect(doc.services.web.ports).toBeInstanceOf(Tagged);

    // An unrelated edit elsewhere must not disturb the tags.
    doc.services.web.deploy = { replicas: 2 };
    const out = dump(doc, { schema });

    expect(out).toContain("ports: !override");
    expect(out).toContain("environment: !reset null");
    expect(out).toContain("labels: !override");
  });
});

describe("containsOverrideTag", () => {
  it("detects a Tagged carrier nested in the spec", () => {
    const spec = { services: { web: { ports: new Tagged("!override", "sequence", []) } } };
    expect(containsOverrideTag(spec)).toBe(true);
  });

  it("returns false for a plain spec", () => {
    expect(containsOverrideTag({ services: { web: { image: "nginx" } } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/override-tags.test.ts`
Expected: FAIL — cannot find `../src/override-tags.js`.

- [ ] **Step 3: Implement**

Create `src/override-tags.ts`:

```ts
import {
  defineMappingTag,
  defineScalarTag,
  defineSequenceTag,
  type TagDefinition,
} from "js-yaml";

/** In-memory carrier for a `!reset` / `!override`-tagged YAML node, preserved
 * through the action's transform and re-emitted on dump. */
export class Tagged {
  constructor(
    readonly tag: string,
    readonly kind: "scalar" | "sequence" | "mapping",
    readonly value: unknown,
  ) {}
}

const isTagged =
  (tag: string, kind: Tagged["kind"]) =>
  (value: unknown): value is Tagged =>
    value instanceof Tagged && value.tag === tag && value.kind === kind;

// One scalar/sequence/mapping definition per tag, so a future standard tag is
// a one-line addition to `overrideTagDefinitions`.
function overrideTag(tag: string): TagDefinition[] {
  return [
    defineScalarTag(tag, {
      resolve: (source: string) => new Tagged(tag, "scalar", source),
      identify: isTagged(tag, "scalar"),
      represent: (value) => String((value as Tagged).value),
    }),
    defineSequenceTag(tag, {
      create: () => new Tagged(tag, "sequence", []),
      addItem: (carrier, item) => {
        ((carrier as Tagged).value as unknown[]).push(item);
      },
      identify: isTagged(tag, "sequence"),
      represent: (value) => (value as Tagged).value as unknown[],
    }),
    defineMappingTag(tag, {
      create: () => new Tagged(tag, "mapping", new Map<unknown, unknown>()),
      addPair: (carrier, key, val) => {
        ((carrier as Tagged).value as Map<unknown, unknown>).set(key, val);
      },
      has: (carrier, key) =>
        ((carrier as Tagged).value as Map<unknown, unknown>).has(key),
      keys: (carrier) => [
        ...((carrier as Tagged).value as Map<unknown, unknown>).keys(),
      ],
      get: (carrier, key) =>
        ((carrier as Tagged).value as Map<unknown, unknown>).get(key),
      identify: isTagged(tag, "mapping"),
      represent: (value) => (value as Tagged).value as Map<unknown, unknown>,
    }),
  ];
}

export const overrideTagDefinitions: TagDefinition[] = [
  ...overrideTag("!override"),
  ...overrideTag("!reset"),
];

/** Deep-scan a parsed spec for any `Tagged` carrier. */
export function containsOverrideTag(value: unknown): boolean {
  if (value instanceof Tagged) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsOverrideTag);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      containsOverrideTag,
    );
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/override-tags.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/override-tags.ts tests/override-tags.test.ts
git commit -m "feat: round-tripping !reset/!override yaml tags"
```

---

### Task 2: `assertMergeableTagUsage` guard

**Files:**
- Modify: `src/override-tags.ts`
- Test: `tests/override-tags.test.ts`

**Interfaces:**
- Consumes: `Tagged` (Task 1).
- Produces:
  - `tagSensitiveServiceKeys: readonly string[]` — service keys reconciliation reads/rewrites: `mem_limit`, `mem_reservation`, `cpus`, `restart`, `depends_on`, `label_file`.
  - `assertMergeableTagUsage(spec: { services?: Record<string, unknown> }): void` — throws if a `Tagged` sits on any tag-sensitive key.

- [ ] **Step 1: Write the failing test**

Add to `tests/override-tags.test.ts` (extend the import with `assertMergeableTagUsage`):

```ts
describe("assertMergeableTagUsage", () => {
  it.each(["mem_limit", "restart", "depends_on", "label_file"])(
    "throws for a tag on the reconciled key %s",
    (key) => {
      const spec = {
        services: { web: { [key]: new Tagged("!override", "scalar", "x") } },
      };
      expect(() => assertMergeableTagUsage(spec)).toThrow(/merge tag/);
    },
  );

  it("allows tags on mergeable collections like ports and environment", () => {
    const spec = {
      services: {
        web: {
          ports: new Tagged("!override", "sequence", []),
          environment: new Tagged("!reset", "scalar", "null"),
        },
      },
    };
    expect(() => assertMergeableTagUsage(spec)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/override-tags.test.ts -t assertMergeableTagUsage`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `src/override-tags.ts`:

```ts
/** Service keys reconciliation reads or rewrites; a merge tag on any of them
 * would be mis-transformed, so we reject it up front. */
export const tagSensitiveServiceKeys = [
  "mem_limit",
  "mem_reservation",
  "cpus",
  "restart",
  "depends_on",
  "label_file",
] as const;

/**
 * Reject `!reset` / `!override` tags placed on keys the action rewrites for
 * Swarm. Those tags apply to mergeable collections (ports, volumes,
 * environment, …), not scalar runtime knobs — using them there is a mistake we
 * surface instead of silently mis-transforming.
 */
export function assertMergeableTagUsage(spec: {
  services?: Record<string, unknown>;
}): void {
  for (const [name, service] of Object.entries(spec.services ?? {})) {
    if (!service || typeof service !== "object") {
      continue;
    }
    const entry = service as Record<string, unknown>;
    for (const key of tagSensitiveServiceKeys) {
      if (entry[key] instanceof Tagged) {
        throw new Error(
          `Service "${name}" applies the "${(entry[key] as Tagged).tag}" ` +
            `merge tag to "${key}", which the action rewrites for Swarm ` +
            `compatibility. The "!reset"/"!override" tags apply to mergeable ` +
            `collections (e.g. ports, volumes, environment), not "${key}".`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/override-tags.test.ts -t assertMergeableTagUsage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/override-tags.ts tests/override-tags.test.ts
git commit -m "feat: guard against merge tags on reconciled keys"
```

---

### Task 3: engine helpers — plugin check and compose merge

**Files:**
- Modify: `src/engine.ts` (after `normalizeStackSpecification`, ~line 88)
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: the private `executeDockerCommand(args, opts)` (same file).
- Produces:
  - `isComposePluginAvailable(): Promise<boolean>` — `docker compose version`; true on success, false on error.
  - `mergeComposeFiles(files: string[]): Promise<string>` — `docker compose --file <a> … config --no-interpolate`; returns merged YAML (stdout).

- [ ] **Step 1: Write the failing test**

Add to `tests/engine.test.ts` (has `mockedExec = vi.mocked(exec)`):

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
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `src/engine.ts`, after `normalizeStackSpecification`:

```ts
/**
 * Check whether the Docker Compose v2 plugin (`docker compose`) is available.
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
 * Merge compose files with `docker compose config`, which honors the
 * `!reset` / `!override` merge tags that `docker stack config` ignores.
 * `--no-interpolate` preserves `${VAR}` for the action's own interpolation.
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

### Task 4: Wire the schema + guard into `compose.ts`

**Files:**
- Modify: `src/compose.ts` (schema at line 26; `reconcileSpec` at ~line 199)
- Test: `tests/override-tags.test.ts` (schema parse), `tests/compose.test.ts` (guard)

**Interfaces:**
- Consumes: `overrideTagDefinitions`, `assertMergeableTagUsage` (Tasks 1–2).
- Produces: `composeSchema` is now exported and includes the override tags; `reconcileSpec` throws (via the guard) on a tag over a reconciled key before reconciling.

- [ ] **Step 1: Write the failing tests**

Add to `tests/override-tags.test.ts`:

```ts
import { composeSchema } from "../src/compose.js";

describe("composeSchema", () => {
  it("parses a spec using !override without throwing", () => {
    const yaml = 'services:\n  web:\n    ports: !override ["80:80"]\n';
    expect(() => load(yaml, { schema: composeSchema })).not.toThrow();
  });
});
```

Add to `tests/compose.test.ts` (in the "Schema Reconciliation" block; import `Tagged` from `../src/override-tags.js`):

```ts
it("rejects a merge tag placed on a reconciled key", async () => {
  const composeSpec = defineComposeSpec({
    services: { web: { image: "nginx", restart: new Tagged("!override", "scalar", "always") } },
  });
  await expect(
    reconcileSpec(composeSpec, { ...settings, manageVariables: false, strictCompatibility: false }),
  ).rejects.toThrow(/merge tag/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/override-tags.test.ts -t composeSchema tests/compose.test.ts -t "reconciled key"`
Expected: FAIL — `composeSchema` not exported / guard not wired.

- [ ] **Step 3: Implement**

In `src/compose.ts`, add the import (extension-less, matching the existing `./engine` import style is not required here — `./override-tags.js` uses `.js`):

```ts
import {
  assertMergeableTagUsage,
  containsOverrideTag,
  overrideTagDefinitions,
} from "./override-tags.js";
```

Change the schema (line 26) to export it and include the tags:

```ts
export const composeSchema = CORE_SCHEMA.withTags(
  mergeTag,
  ...overrideTagDefinitions,
);
```

In `reconcileSpec`, immediately after the services-presence check (line ~196) and before `await reconcileSwarmCompatibility(...)`:

```ts
  assertMergeableTagUsage(composeSpec);
```

(`containsOverrideTag` is imported now for Task 5; it is unused until then — if the linter flags it, add it in Task 5 instead. To keep this task lint-clean, import only `assertMergeableTagUsage` and `overrideTagDefinitions` here, and add `containsOverrideTag` in Task 5.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/override-tags.test.ts tests/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/compose.ts tests/override-tags.test.ts tests/compose.test.ts
git commit -m "feat: register override tags in the compose schema; guard usage"
```

---

### Task 5: Merge-tool selection in `normalizeSpec`

**Files:**
- Modify: `src/compose.ts` (`normalizeSpec`; add `containsOverrideTag` + engine imports)
- Test: `tests/compose.test.ts`

**Interfaces:**
- Consumes: `containsOverrideTag` (Task 1); `isComposePluginAvailable`, `mergeComposeFiles` (Task 3).
- Produces: `normalizeSpec` merges tag-bearing specs via `docker compose config` before `docker stack config`; no-tag specs are unchanged; plugin-missing throws.

- [ ] **Step 1: Write the failing tests**

Add to `tests/compose.test.ts` (add `import * as engine from "../src/engine"` and `Tagged` from `../src/override-tags.js` if not present):

```ts
describe("normalizeSpec override-tag merge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges via docker compose then normalizes when tags are present", async () => {
    vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(true);
    vi.spyOn(engine, "mergeComposeFiles").mockResolvedValue("merged: true\n");
    const normalize = vi
      .spyOn(engine, "normalizeStackSpecification")
      .mockResolvedValue({ services: { web: { image: "nginx" } } });

    const specs = [
      { services: { web: { image: "nginx", ports: new Tagged("!override", "sequence", []) } } },
    ] as unknown as Parameters<typeof normalizeSpec>[0];

    await normalizeSpec(specs, settings);

    expect(engine.mergeComposeFiles).toHaveBeenCalled();
    // normalize runs on a single merged file
    expect(normalize).toHaveBeenCalledWith(
      [expect.stringMatching(/^docker-compose\.merged\..*\.yaml$/)],
      settings,
      true,
    );
  });

  it("throws when tags are present but the compose plugin is missing", async () => {
    vi.spyOn(engine, "isComposePluginAvailable").mockResolvedValue(false);
    const merge = vi.spyOn(engine, "mergeComposeFiles");
    const specs = [
      { services: { web: { ports: new Tagged("!override", "sequence", []) } } },
    ] as unknown as Parameters<typeof normalizeSpec>[0];

    await expect(normalizeSpec(specs, settings)).rejects.toThrow(/Docker Compose v2 plugin/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("uses docker stack config directly when no tags are present", async () => {
    const merge = vi.spyOn(engine, "mergeComposeFiles");
    vi.spyOn(engine, "normalizeStackSpecification").mockResolvedValue({
      services: { web: { image: "nginx" } },
    });

    const specs = [{ services: { web: { image: "nginx" } } }] as unknown as Parameters<
      typeof normalizeSpec
    >[0];
    await normalizeSpec(specs, settings);

    expect(merge).not.toHaveBeenCalled();
    expect(engine.normalizeStackSpecification).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compose.test.ts -t "normalizeSpec override-tag"`
Expected: FAIL — merge branch not implemented.

- [ ] **Step 3: Implement**

In `src/compose.ts`, extend the engine import to include the new helpers:

```ts
import {
  isComposePluginAvailable,
  mergeComposeFiles,
  normalizeStackSpecification,
} from "./engine";
```

and ensure `containsOverrideTag` is imported from `./override-tags.js`.

Replace the body of `normalizeSpec` with:

```ts
export async function normalizeSpec(
  composeSpecs: ComposeSpec[],
  settings: Readonly<Settings>,
) {
  // Serialize each (possibly transformed) spec so Docker can merge them. Use
  // the tag-aware schema so any !reset/!override carriers re-emit faithfully.
  const generated = await Promise.all(
    composeSpecs.map(async (spec) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec, { schema: composeSchema }));
      return file;
    }),
  );

  const tempFiles = [...generated];

  try {
    let filesToNormalize = generated;

    // Merge tags are only honored by `docker compose config`; `docker stack
    // config` ignores them. Route through Compose only when tags are present.
    if (composeSpecs.some(containsOverrideTag)) {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compose.test.ts`
Expected: PASS (new tests + the existing "should normalize and merge the spec", which has no tags → `docker stack config` path).

- [ ] **Step 5: Commit**

```bash
npm run format:write
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: merge override-tag specs via docker compose config"
```

---

### Task 6: Docs, local-merge verification, pipeline, dist

**Files:**
- Modify: `README.md` (the "Compose → Swarm reconciliation" section, ~line 225)
- Regenerated: `dist/`

- [ ] **Step 1: Verify `docker compose config` stays local under a remote host**

Run:
```bash
cd /tmp && printf 'services:\n  web:\n    image: nginx\n    ports: ["80:80"]\n' > b.yaml && \
printf 'services:\n  web:\n    ports: !override ["8080:80"]\n' > o.yaml && \
DOCKER_HOST=tcp://127.0.0.1:2375 timeout 15 docker compose -f b.yaml -f o.yaml config --no-interpolate
```
Expected: prints the merged config with only `8080` published, within a second — it does **not** hang trying to reach the unreachable `DOCKER_HOST`. If it hangs/errors on the connection, stop and report (the design would need to unset `DOCKER_HOST` for the merge call).

- [ ] **Step 2: Document it**

In `README.md`, under "Compose → Swarm reconciliation", add (prose ≤ 80 chars/line):

```markdown
##### `!reset` / `!override` merge tags

Compose files may use the standard `!reset` and `!override` merge tags to
control how base and override files combine. When present, the action
merges the files with `docker compose config` (which honors the tags)
before normalizing for Swarm — after its own transforms run, so
content-based secrets and reconciliation are unaffected. This requires
the Docker Compose v2 plugin on the runner (included on GitHub-hosted
runners); if it is missing and these tags are used, the action fails with
a clear error rather than merging incorrectly.
```

- [ ] **Step 3: Run the full pipeline**

Run: `npm run all`
Expected: format, lint, typecheck, all tests, and package pass; `dist/` regenerated. (Pre-existing flaky sleep test in `tests/utils.test.ts` may need one rerun; do not modify it.)

- [ ] **Step 4: Commit**

```bash
git add README.md dist/ badges/coverage.svg
git commit -m "docs: document !reset/!override support; rebuild dist"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/compose-override-tags
gh pr create --title "feat: support !reset/!override compose merge tags" --body "<summary + link to the design doc and the merge-engine/round-trip findings>"
```

---

## Self-Review

**Spec coverage:**
- §1 round-tripping tag registration (`Tagged`, definitions, `containsOverrideTag`) → Task 1; schema wiring → Task 4. ✓
- §2 merge-tool selection in `normalizeSpec` (dump with schema, detect, plugin check, compose merge, stack normalize) → Task 5. ✓
- §3 engine helpers → Task 3. ✓
- §4 edge-case guard (`assertMergeableTagUsage`, sensitive keys, wired in `reconcileSpec`) → Task 2 + Task 4. ✓
- Error handling (plugin-missing message; compose stderr via `executeDockerCommand`) → Tasks 3, 5. ✓
- Interaction note: local-only `docker compose config` under remote host → Task 6 Step 1. ✓
- Scope (two standard tags only; no invented tags) → honored throughout; `overrideTag` helper is the documented extension point. ✓
- Testing (round-trip, detector, guard, engine, normalizeSpec branch; integration guarded) → Tasks 1–5 unit tests; end-to-end integration covered pragmatically by Task 6 Step 1's manual verification (kept out of CI unit tests to avoid a Docker dependency). ✓
- Docs → Task 6. ✓

**Placeholder scan:** No TBD/TODO. Every code step is complete. Only free-text is the PR body and README prose (inherently narrative). ✓

**Type consistency:** `Tagged(tag, kind, value)` constructor used identically in tests and guard. `containsOverrideTag(value): boolean`, `assertMergeableTagUsage(spec)`, `isComposePluginAvailable()`, `mergeComposeFiles(files: string[]): Promise<string>` consistent across tasks. `composeSchema` exported in Task 4, consumed in Task 5's `dump(spec, { schema: composeSchema })`. Engine functions imported from `"./engine"` (no extension) to match `compose.ts`; `./override-tags.js` uses the `.js` extension. ✓
