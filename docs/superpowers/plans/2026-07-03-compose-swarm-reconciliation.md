# Compose → Swarm Active Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate modern Compose Specification constructs into `docker stack deploy`-compatible form (and strip/warn on the rest) before the spec reaches `docker stack config`, so the action stops hard-failing on modern compose files.

**Architecture:** A new focused module `src/reconcile.ts` exposes one async function `reconcileSwarmCompatibility(spec, settings)` that mutates the parsed spec in place. It applies bespoke translate functions (resources, restart, depends_on, label_file), data-table strip/warn rules, and unknown-key validation, emitting diagnostics via `@actions/core`. An opt-in `strict-compatibility` setting aggregates all diagnostics into one thrown error. It is called from `reconcileSpec` in `compose.ts`, before the spec is serialized and fed to `docker stack config`.

**Tech Stack:** TypeScript (strict, ESM), `@actions/core`, Vitest, Biome. Node 24.

## Global Constraints

- Runtime: Node 24, ESM (`"type": "module"`); intra-repo imports use the `.js` extension (e.g. `import type { Settings } from "./settings.js"`).
- Tooling: **Biome** for lint/format (not ESLint/Prettier); **Vitest** for tests. Run `npm run all` (format, lint, typecheck, test, package) before pushing; commit the regenerated `dist/`.
- After changing dependencies run `npm install` (never hand-edit `package-lock.json`). No new dependencies are required by this plan.
- `ComposeSpec` (`src/compose.ts:316-323`) has `services: Record<string, unknown>` and an open `[key: string]: unknown`; individual services are cast inline where needed (pattern: `service as { mem_limit?: string }`), matching `healthcheck.ts:27`.
- Diagnostics use `@actions/core`: `core.warning(msg)` for issues, `core.info(msg)` for clean translations. Match the message style in `healthcheck.ts` (e.g. `Service "api" ...`).
- Empirically verified against `docker stack config` (Docker 29.4): forbidden (hard-fail) keys — `mem_limit`, `mem_reservation`-as-top-level, `cpus`, `gpus`, `depends_on` map form, `label_file`, `develop`, `post_start`, `pre_stop`, `profiles`, `provider`, `memswap_limit`, top-level `models`. Accepted-but-ignored — `restart` (top-level), `container_name`, `build`. Valid translation targets — `deploy.resources.limits.{cpus,memory}`, `deploy.resources.reservations.memory`, `deploy.restart_policy`, `depends_on` list, `labels` map.

## File Structure

- **Create** `src/reconcile.ts` — the reconciliation module (rule catalog + translate functions + unknown-key validation + strict aggregation).
- **Create** `tests/reconcile.test.ts` — unit tests for `reconcileSwarmCompatibility` (no Docker dependency; assert on the mutated object and `core` calls).
- **Modify** `src/settings.ts` — add `strictCompatibility` to `Settings` and `parseSettings`.
- **Modify** `action.yml` — add the `strict-compatibility` input.
- **Modify** `src/compose.ts` — import and `await reconcileSwarmCompatibility(...)` inside `reconcileSpec`.
- **Modify** `tests/compose.test.ts` — one integration test: a modern multi-key spec through `reconcileSpec` yields only v3-compatible keys.
- **Modify** `tests/settings.test.ts` — assert `strict-compatibility` parses and defaults to `false`.

---

### Task 1: `strict-compatibility` setting and input

**Files:**
- Modify: `src/settings.ts:7-20` (Settings interface), `src/settings.ts:48-68` (parseSettings return)
- Modify: `action.yml` (add input after `strict-variables`, ~line 83)
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: `Settings.strictCompatibility: boolean` (default `false`), parsed from the `strict-compatibility` action input.

- [ ] **Step 1: Write the failing test**

Add inside the existing `parseSettings` describe block in `tests/settings.test.ts` (mirror how other boolean inputs are asserted there):

```ts
it("defaults strictCompatibility to false", () => {
  const settings = parseSettings({ GITHUB_REPOSITORY: "matchory/app" });
  expect(settings.strictCompatibility).toBe(false);
});

it("parses strict-compatibility input when set", () => {
  vi.stubEnv("INPUT_STRICT-COMPATIBILITY", "true");
  const settings = parseSettings({ GITHUB_REPOSITORY: "matchory/app" });
  expect(settings.strictCompatibility).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts -t strictCompatibility`
Expected: FAIL — `strictCompatibility` is `undefined`.

- [ ] **Step 3: Add the field to the interface**

In `src/settings.ts`, add to the `Settings` interface (keep alphabetical grouping near `strictVariables`):

```ts
  strictCompatibility: boolean;
```

- [ ] **Step 4: Parse the input**

In the `defineSettings({...})` return of `parseSettings`, add above `strictVariables`:

```ts
    strictCompatibility:
      getBooleanInput("strict-compatibility", { required: false }) ?? false,
```

- [ ] **Step 5: Add the action input**

In `action.yml`, after the `strict-variables` block, add:

```yaml
  strict-compatibility:
    description: >-
      Whether to fail the deployment when the Compose Specification contains
      features that Docker Swarm does not support and cannot be translated
      (e.g. develop, profiles, provider). When false (the default), such
      features are stripped or translated with a warning instead of failing.
    default: "false"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts -t strictCompatibility`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/settings.ts action.yml tests/settings.test.ts
git commit -m "feat: add strict-compatibility setting"
```

---

### Task 2: Module skeleton, diagnostics, strict aggregation, warn-only rules

**Files:**
- Create: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Consumes: `ComposeSpec` from `./compose.js`, `Settings` from `./settings.js`.
- Produces: `reconcileSwarmCompatibility(spec: ComposeSpec, settings: Pick<Readonly<Settings>, "strictCompatibility">): Promise<void>`. Mutates `spec` in place. Emits `core.warning` per issue; in strict mode throws one aggregated `Error` after processing everything.
- Internal (used by later tasks in this file): a `Diagnostics` accumulator with `warn(message: string)` (calls `core.warning` and records a violation) and `note(message: string)` (calls `core.info`, not a violation).

- [ ] **Step 1: Write the failing test**

Create `tests/reconcile.test.ts`:

```ts
import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import { reconcileSwarmCompatibility } from "../src/reconcile.js";

vi.mock("@actions/core");

function spec(services: Record<string, unknown>): ComposeSpec {
  return { services } as ComposeSpec;
}

describe("reconcileSwarmCompatibility", () => {
  beforeEach(() => vi.resetAllMocks());

  describe("warn-only rules", () => {
    it("warns about container_name but leaves it in place", async () => {
      const s = spec({ api: { image: "nginx", container_name: "api" } });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("container_name"),
      );
      expect(s.services.api).toHaveProperty("container_name", "api");
    });

    it("warns about build but leaves it in place", async () => {
      const s = spec({ api: { image: "nginx", build: { context: "." } } });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("build"));
      expect(s.services.api).toHaveProperty("build");
    });

    it("aggregates diagnostics into a thrown error in strict mode", async () => {
      const s = spec({ api: { image: "nginx", container_name: "api" } });
      await expect(
        reconcileSwarmCompatibility(s, { strictCompatibility: true }),
      ).rejects.toThrow(/container_name/);
    });

    it("does not throw in strict mode when there are no issues", async () => {
      const s = spec({ api: { image: "nginx" } });
      await expect(
        reconcileSwarmCompatibility(s, { strictCompatibility: true }),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: FAIL — cannot find module `../src/reconcile.js`.

- [ ] **Step 3: Write the module skeleton**

Create `src/reconcile.ts`:

```ts
import * as core from "@actions/core";
import type { ComposeSpec } from "./compose.js";
import type { Settings } from "./settings.js";

/** Service-level keys that pass `docker stack config` but are ignored by
 * swarm at deploy time. We leave them in place and warn. */
const WARN_ONLY: Array<{ key: string; message: (service: string) => string }> = [
  {
    key: "container_name",
    message: (s) =>
      `Service "${s}" sets "container_name", which Docker Swarm ignores; ` +
      `swarm names tasks itself.`,
  },
  {
    key: "build",
    message: (s) =>
      `Service "${s}" defines "build", which Docker Swarm ignores; ` +
      `provide a pre-built "image" and push it to a registry.`,
  },
];

class Diagnostics {
  private readonly violations: string[] = [];

  warn(message: string): void {
    core.warning(message);
    this.violations.push(message);
  }

  note(message: string): void {
    core.info(message);
  }

  finish(strict: boolean): void {
    if (strict && this.violations.length > 0) {
      throw new Error(
        `Compose specification contains ${this.violations.length} ` +
          `swarm-incompatible feature(s) and strict-compatibility is enabled:\n` +
          this.violations.map((v) => `  - ${v}`).join("\n"),
      );
    }
  }
}

/**
 * Reconcile modern Compose Specification constructs into a form
 * `docker stack deploy` accepts. Translates what has a faithful swarm
 * equivalent, strips what does not (with a warning), and validates
 * unknown keys. Mutates `spec` in place.
 */
export async function reconcileSwarmCompatibility(
  spec: ComposeSpec,
  settings: Pick<Readonly<Settings>, "strictCompatibility">,
): Promise<void> {
  const diagnostics = new Diagnostics();

  for (const [name, service] of Object.entries(spec.services)) {
    const entry = service as Record<string, unknown>;
    applyWarnOnly(name, entry, diagnostics);
  }

  diagnostics.finish(settings.strictCompatibility);
}

function applyWarnOnly(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const rule of WARN_ONLY) {
    if (rule.key in service) {
      diagnostics.warn(rule.message(name));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: reconcile module skeleton with warn-only rules"
```

---

### Task 3: Translate resource limits/reservations

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Consumes: `Diagnostics`, the per-service loop in `reconcileSwarmCompatibility`.
- Produces: `translateResources(name, service, diagnostics)` — moves `mem_limit`→`deploy.resources.limits.memory`, `cpus`→`deploy.resources.limits.cpus`, `mem_reservation`→`deploy.resources.reservations.memory`. Non-clobbering; always deletes the source key (forbidden by stack config). Also a shared helper `ensurePath(service, ["deploy","resources","limits"])` returning the nested object.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`:

```ts
describe("translate resources", () => {
  it("moves mem_limit and cpus into deploy.resources.limits", async () => {
    const s = spec({ api: { image: "nginx", mem_limit: "512m", cpus: 1.5 } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services.api).toEqual({
      image: "nginx",
      deploy: { resources: { limits: { memory: "512m", cpus: "1.5" } } },
    });
  });

  it("moves mem_reservation into deploy.resources.reservations", async () => {
    const s = spec({ api: { image: "nginx", mem_reservation: "128m" } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services.api).toEqual({
      image: "nginx",
      deploy: { resources: { reservations: { memory: "128m" } } },
    });
  });

  it("does not overwrite an existing limit but still removes the source", async () => {
    const s = spec({
      api: {
        image: "nginx",
        mem_limit: "512m",
        deploy: { resources: { limits: { memory: "1g" } } },
      },
    });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect((s.services.api as { deploy: unknown }).deploy).toEqual({
      resources: { limits: { memory: "1g" } },
    });
    expect(s.services.api).not.toHaveProperty("mem_limit");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("mem_limit"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "translate resources"`
Expected: FAIL — `mem_limit` still present, no `deploy`.

- [ ] **Step 3: Implement the translation**

In `src/reconcile.ts`, add the helper and function, and call it in the loop before `applyWarnOnly`:

```ts
function ensurePath(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let node = root;
  for (const key of path) {
    if (typeof node[key] !== "object" || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  return node;
}

const RESOURCE_TRANSLATIONS: Array<{
  key: string;
  path: string[];
  target: string;
}> = [
  { key: "mem_limit", path: ["deploy", "resources", "limits"], target: "memory" },
  { key: "cpus", path: ["deploy", "resources", "limits"], target: "cpus" },
  {
    key: "mem_reservation",
    path: ["deploy", "resources", "reservations"],
    target: "memory",
  },
];

function translateResources(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const { key, path, target } of RESOURCE_TRANSLATIONS) {
    if (!(key in service)) {
      continue;
    }
    const value = String(service[key]);
    delete service[key];
    const node = ensurePath(service, path);
    if (target in node) {
      diagnostics.warn(
        `Service "${name}" sets both "${key}" and deploy.resources.` +
          `${path[2]}.${target}; keeping the deploy value and dropping "${key}".`,
      );
      continue;
    }
    node[target] = value;
    diagnostics.note(
      `Service "${name}": translated "${key}" to deploy.resources.` +
        `${path[2]}.${target}.`,
    );
  }
}
```

Call it in the loop:

```ts
    translateResources(name, entry, diagnostics);
    applyWarnOnly(name, entry, diagnostics);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "translate resources"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: translate resource shorthands to deploy.resources"
```

---

### Task 4: Translate `restart` → `deploy.restart_policy`

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Produces: `translateRestart(name, service, diagnostics)` — moves top-level `restart` to `deploy.restart_policy.condition` using the value map `no→none`, `always→any`, `on-failure[:N]→on-failure`, `unless-stopped→any` (with a warning for the approximation). Non-clobbering: if `deploy.restart_policy` exists, delete `restart` and warn.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`:

```ts
describe("translate restart", () => {
  it.each([
    ["no", "none"],
    ["always", "any"],
    ["on-failure", "on-failure"],
    ["on-failure:5", "on-failure"],
  ])("maps restart '%s' to condition '%s'", async (restart, condition) => {
    const s = spec({ api: { image: "nginx", restart } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services.api).toEqual({
      image: "nginx",
      deploy: { restart_policy: { condition } },
    });
  });

  it("maps unless-stopped to any with a warning", async () => {
    const s = spec({ api: { image: "nginx", restart: "unless-stopped" } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services.api).toEqual({
      image: "nginx",
      deploy: { restart_policy: { condition: "any" } },
    });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("unless-stopped"),
    );
  });

  it("drops restart and warns when restart_policy already exists", async () => {
    const s = spec({
      api: { image: "nginx", restart: "always", deploy: { restart_policy: { condition: "none" } } },
    });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect((s.services.api as { deploy: unknown }).deploy).toEqual({
      restart_policy: { condition: "none" },
    });
    expect(s.services.api).not.toHaveProperty("restart");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "translate restart"`
Expected: FAIL — `restart` still present.

- [ ] **Step 3: Implement the translation**

Add to `src/reconcile.ts` and call `translateRestart(name, entry, diagnostics)` in the loop after `translateResources`:

```ts
function restartCondition(restart: string): string {
  if (restart === "no") return "none";
  if (restart === "always" || restart === "unless-stopped") return "any";
  return "on-failure"; // covers "on-failure" and "on-failure:N"
}

function translateRestart(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  if (!("restart" in service)) {
    return;
  }
  const restart = String(service.restart);
  delete service.restart;
  const deploy = ensurePath(service, ["deploy"]);
  if ("restart_policy" in deploy) {
    diagnostics.warn(
      `Service "${name}" sets both "restart" and deploy.restart_policy; ` +
        `keeping deploy.restart_policy and dropping "restart".`,
    );
    return;
  }
  if (restart === "unless-stopped") {
    diagnostics.warn(
      `Service "${name}": "restart: unless-stopped" has no swarm equivalent; ` +
        `translated to restart_policy condition "any".`,
    );
  } else {
    diagnostics.note(
      `Service "${name}": translated "restart: ${restart}" to ` +
        `deploy.restart_policy.condition "${restartCondition(restart)}".`,
    );
  }
  deploy.restart_policy = { condition: restartCondition(restart) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "translate restart"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: translate top-level restart to deploy.restart_policy"
```

---

### Task 5: Translate `depends_on` map form → list

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Produces: `translateDependsOn(name, service, diagnostics)` — if `depends_on` is a non-array object (long/condition form), replace it with an array of its keys and warn that conditions are dropped. Array form is left unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`:

```ts
describe("translate depends_on", () => {
  it("converts map form to a list and warns conditions are dropped", async () => {
    const s = spec({
      api: {
        image: "nginx",
        depends_on: { db: { condition: "service_healthy" }, cache: { condition: "service_started" } },
      },
      db: { image: "postgres" },
      cache: { image: "redis" },
    });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect((s.services.api as { depends_on: unknown }).depends_on).toEqual(["db", "cache"]);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("depends_on"));
  });

  it("leaves list form unchanged and does not warn", async () => {
    const s = spec({ api: { image: "nginx", depends_on: ["db"] }, db: { image: "postgres" } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect((s.services.api as { depends_on: unknown }).depends_on).toEqual(["db"]);
    expect(core.warning).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "translate depends_on"`
Expected: FAIL — map form not converted.

- [ ] **Step 3: Implement the translation**

Add to `src/reconcile.ts` and call `translateDependsOn(name, entry, diagnostics)` in the loop after `translateRestart`:

```ts
function translateDependsOn(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  const dependsOn = service.depends_on;
  if (
    typeof dependsOn !== "object" ||
    dependsOn === null ||
    Array.isArray(dependsOn)
  ) {
    return;
  }
  service.depends_on = Object.keys(dependsOn);
  diagnostics.warn(
    `Service "${name}" uses the long "depends_on" syntax; Docker Swarm has ` +
      `no startup ordering, so conditions are dropped and only the ` +
      `dependency list is kept.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "translate depends_on"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: convert depends_on map form to list for swarm"
```

---

### Task 6: Strip-and-warn rules (incl. `provider` dropping the service, top-level `models`)

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Produces: `applyStrips(name, service, diagnostics)` (service-level), `applyProvider(name, spec, diagnostics)` (drops the whole service, returns `true` if dropped), and `applyTopLevelStrips(spec, diagnostics)` (removes top-level `models`). `STRIP_KEYS` data table drives the service-level strips.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`:

```ts
describe("strip-and-warn rules", () => {
  it.each(["develop", "post_start", "pre_stop", "profiles", "memswap_limit", "gpus"])(
    "strips %s and warns",
    async (key) => {
      const s = spec({ api: { image: "nginx", [key]: "x" } });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(s.services.api).not.toHaveProperty(key);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(key));
    },
  );

  it("drops a provider service entirely and warns", async () => {
    const s = spec({
      api: { image: "nginx" },
      ai: { provider: { type: "model" } },
    });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services).not.toHaveProperty("ai");
    expect(s.services).toHaveProperty("api");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("ai"));
  });

  it("strips top-level models and warns", async () => {
    const s = { services: { api: { image: "nginx" } }, models: { chat: {} } } as ComposeSpec;
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s).not.toHaveProperty("models");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("models"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "strip-and-warn"`
Expected: FAIL — keys/services not stripped.

- [ ] **Step 3: Implement the strips**

Add to `src/reconcile.ts`:

```ts
const STRIP_KEYS: Array<{ key: string; reason: string }> = [
  { key: "develop", reason: "development watch config is not supported by swarm" },
  { key: "post_start", reason: "lifecycle hooks are not supported by swarm" },
  { key: "pre_stop", reason: "lifecycle hooks are not supported by swarm" },
  { key: "profiles", reason: "profiles are not supported by swarm; all services are always deployed" },
  { key: "memswap_limit", reason: "swarm has no swap-limit control" },
  {
    key: "gpus",
    reason:
      "GPU shorthand is not supported by swarm; use " +
      "deploy.resources.reservations.generic_resources with node labels",
  },
];

function applyStrips(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const { key, reason } of STRIP_KEYS) {
    if (key in service) {
      delete service[key];
      diagnostics.warn(`Service "${name}": removed "${key}" — ${reason}.`);
    }
  }
}

function applyProvider(
  name: string,
  spec: ComposeSpec,
  diagnostics: Diagnostics,
): boolean {
  const service = spec.services[name] as Record<string, unknown>;
  if (!("provider" in service)) {
    return false;
  }
  delete spec.services[name];
  diagnostics.warn(
    `Service "${name}" is a provider service, which Docker Swarm cannot run; ` +
      `the service has been removed from the stack.`,
  );
  return true;
}

function applyTopLevelStrips(spec: ComposeSpec, diagnostics: Diagnostics): void {
  if ("models" in spec) {
    delete spec.models;
    diagnostics.warn(
      `Removed top-level "models" — the model runner is not supported by swarm.`,
    );
  }
}
```

Wire them into the loop. Provider is checked first and short-circuits the service; top-level strips run before the loop:

```ts
  applyTopLevelStrips(spec, diagnostics);

  for (const [name, service] of Object.entries(spec.services)) {
    if (applyProvider(name, spec, diagnostics)) {
      continue;
    }
    const entry = service as Record<string, unknown>;
    translateResources(name, entry, diagnostics);
    translateRestart(name, entry, diagnostics);
    translateDependsOn(name, entry, diagnostics);
    applyStrips(name, entry, diagnostics);
    applyWarnOnly(name, entry, diagnostics);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "strip-and-warn"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: strip swarm-unsupported keys and provider services"
```

---

### Task 7: Translate `label_file` → merge into `labels`

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Produces: `translateLabelFile(name, service, diagnostics)` (async) — reads the `label_file` path(s), parses `KEY=VALUE` lines, merges into `service.labels` (existing explicit labels win), deletes `label_file`. Paths are resolved against `GITHUB_WORKSPACE || cwd` and rejected if they escape it. Uses `readFile` from `node:fs/promises`. Because this is async, it is `await`ed inside the per-service loop.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`. Mock `node:fs/promises` at the top of the file (add alongside the existing `vi.mock("@actions/core")`):

```ts
const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile }));
```

Then:

```ts
describe("translate label_file", () => {
  it("merges label file entries into labels, existing labels winning", async () => {
    readFile.mockResolvedValue("com.example.team=platform\ncom.example.env=prod\n");
    const s = spec({
      api: { image: "nginx", label_file: "./labels.env", labels: { "com.example.env": "staging" } },
    });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(s.services.api).toEqual({
      image: "nginx",
      labels: { "com.example.env": "staging", "com.example.team": "platform" },
    });
  });

  it("rejects a label_file path that escapes the workspace", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", "/work");
    const s = spec({ api: { image: "nginx", label_file: "../secrets.env" } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(readFile).not.toHaveBeenCalled();
    expect(s.services.api).not.toHaveProperty("label_file");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("outside the workspace"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "translate label_file"`
Expected: FAIL — `label_file` not processed.

- [ ] **Step 3: Implement the translation**

Add imports at the top of `src/reconcile.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
```

Add the function and `await` it in the loop (before `applyStrips`):

```ts
function withinWorkspace(path: string): string | null {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  const resolved = resolve(workspace, path);
  return resolved === workspace || resolved.startsWith(prefix) ? resolved : null;
}

function parseEnvFile(content: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    labels[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return labels;
}

async function translateLabelFile(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): Promise<void> {
  if (!("label_file" in service)) {
    return;
  }
  const raw = service.label_file;
  delete service.label_file;
  const paths = Array.isArray(raw) ? raw.map(String) : [String(raw)];

  const fromFiles: Record<string, string> = {};
  for (const path of paths) {
    const resolved = withinWorkspace(path);
    if (!resolved) {
      diagnostics.warn(
        `Service "${name}": label_file "${path}" resolves outside the ` +
          `workspace and was skipped.`,
      );
      continue;
    }
    Object.assign(fromFiles, parseEnvFile(await readFile(resolved, "utf8")));
  }

  const existing = (service.labels as Record<string, string>) ?? {};
  service.labels = { ...fromFiles, ...existing };
  diagnostics.note(`Service "${name}": merged label_file entries into labels.`);
}
```

Wire into the loop (note the surrounding function is already `async`):

```ts
    translateDependsOn(name, entry, diagnostics);
    await translateLabelFile(name, entry, diagnostics);
    applyStrips(name, entry, diagnostics);
```

Note: this assumes `labels` is the map form. If a project uses the list form of `labels`, that is out of scope for this task (documented in the spec's non-goals); the merge targets the map form only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "translate label_file"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: translate label_file into service labels"
```

---

### Task 8: Unknown-key validation with did-you-mean

**Files:**
- Modify: `src/reconcile.ts`
- Test: `tests/reconcile.test.ts`

**Interfaces:**
- Produces: `validateServiceKeys(name, service, diagnostics)` and `validateTopLevelKeys(spec, diagnostics)` — after all rules have run, flag any remaining key not in `KNOWN_SERVICE_KEYS` / `KNOWN_TOP_LEVEL_KEYS` (ignoring `x-` extension keys). Append a `— did you mean "X"?` suggestion when the Levenshtein distance to a known key is ≤ 2. Helper `closestKey(key, known): string | null`.

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts`:

```ts
describe("unknown-key validation", () => {
  it("warns on an unknown service key with a did-you-mean suggestion", async () => {
    const s = spec({ api: { image: "nginx", imagee: "typo" } });
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('did you mean "image"'),
    );
  });

  it("does not flag x- extension keys", async () => {
    const s = { services: { api: { image: "nginx", "x-custom": 1 } }, "x-top": 2 } as ComposeSpec;
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("warns on an unknown top-level key", async () => {
    const s = { services: { api: { image: "nginx" } }, servics: {} } as ComposeSpec;
    await reconcileSwarmCompatibility(s, { strictCompatibility: false });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("servics"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "unknown-key validation"`
Expected: FAIL — no warning for unknown keys.

- [ ] **Step 3: Implement the validation**

Add to `src/reconcile.ts`. Place `validateServiceKeys` at the end of the per-service loop and `validateTopLevelKeys` after the loop, before `diagnostics.finish(...)`:

```ts
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version", "name", "services", "networks", "volumes", "configs", "secrets",
  "include",
]);

const KNOWN_SERVICE_KEYS = new Set([
  "image", "build", "command", "entrypoint", "environment", "env_file",
  "ports", "expose", "volumes", "volumes_from", "networks", "network_mode",
  "depends_on", "restart", "deploy", "healthcheck", "labels", "label_file",
  "container_name", "hostname", "domainname", "dns", "dns_search", "dns_opt",
  "extra_hosts", "cap_add", "cap_drop", "devices", "security_opt", "sysctls",
  "ulimits", "user", "working_dir", "stop_grace_period", "stop_signal", "tty",
  "stdin_open", "init", "read_only", "privileged", "shm_size", "pid", "ipc",
  "cgroup", "cgroup_parent", "configs", "secrets", "logging", "mem_limit",
  "mem_reservation", "memswap_limit", "cpus", "cpu_shares", "cpu_quota",
  "cpu_count", "cpu_percent", "cpuset", "profiles", "develop", "post_start",
  "pre_stop", "provider", "gpus", "extends", "mac_address", "platform",
  "pull_policy", "isolation", "runtime", "group_add", "oom_score_adj",
  "oom_kill_disable", "links", "external_links", "blkio_config", "storage_opt",
  "annotations", "attach", "credential_spec", "device_cgroup_rules", "scale",
  "uts", "secrets",
]);

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

function closestKey(key: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestDistance = 3; // require distance <= 2
  for (const candidate of known) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function suggestion(key: string, known: Set<string>): string {
  const closest = closestKey(key, known);
  return closest ? ` — did you mean "${closest}"?` : "";
}

function validateServiceKeys(
  name: string,
  service: Record<string, unknown>,
  diagnostics: Diagnostics,
): void {
  for (const key of Object.keys(service)) {
    if (key.startsWith("x-") || KNOWN_SERVICE_KEYS.has(key)) {
      continue;
    }
    diagnostics.warn(
      `Unknown property "${key}" on service "${name}"` +
        suggestion(key, KNOWN_SERVICE_KEYS) +
        ".",
    );
  }
}

function validateTopLevelKeys(spec: ComposeSpec, diagnostics: Diagnostics): void {
  for (const key of Object.keys(spec)) {
    if (key.startsWith("x-") || KNOWN_TOP_LEVEL_KEYS.has(key)) {
      continue;
    }
    diagnostics.warn(
      `Unknown top-level property "${key}"` +
        suggestion(key, KNOWN_TOP_LEVEL_KEYS) +
        ".",
    );
  }
}
```

Wire in: add `validateServiceKeys(name, entry, diagnostics)` as the last call inside the loop, and `validateTopLevelKeys(spec, diagnostics)` after the loop (before `diagnostics.finish`). Because `models` is stripped in Task 6 before this runs, it will not be flagged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts -t "unknown-key validation"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: validate unknown compose keys with did-you-mean"
```

---

### Task 9: Wire reconciliation into `reconcileSpec` + integration test

**Files:**
- Modify: `src/compose.ts:181-225` (`reconcileSpec`), import at `src/compose.ts:1-10`
- Test: `tests/compose.test.ts` (Spec Loading / Reconciliation area)

**Interfaces:**
- Consumes: `reconcileSwarmCompatibility` from `./reconcile.js`.
- Produces: `reconcileSpec` now applies swarm-compatibility reconciliation before secret/config processing, so `loadComposeSpecs` output is swarm-valid.

- [ ] **Step 1: Write the failing test**

Add to `tests/compose.test.ts` in the "Schema Reconciliation" describe block (`reconcileSpec` is already imported there):

```ts
it("reconciles modern compose keys into swarm-compatible form", async () => {
  const composeSpec = defineComposeSpec({
    services: {
      api: { image: "nginx", mem_limit: "512m", restart: "always", develop: { watch: [] } },
    },
  });
  const result = await reconcileSpec(composeSpec, {
    ...settings,
    manageVariables: false,
  });
  expect(result.services.api).toEqual({
    image: "nginx",
    deploy: { resources: { limits: { memory: "512m" } }, restart_policy: { condition: "any" } },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compose.test.ts -t "reconciles modern compose keys"`
Expected: FAIL — `mem_limit`/`restart`/`develop` still present (reconcileSpec doesn't call the new function yet).

- [ ] **Step 3: Wire it in**

In `src/compose.ts`, add the import:

```ts
import { reconcileSwarmCompatibility } from "./reconcile.js";
```

In `reconcileSpec`, after the `services` presence check (`compose.ts:195`) and before the `if (settings.manageVariables)` block:

```ts
  await reconcileSwarmCompatibility(composeSpec, settings);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compose.test.ts -t "reconciles modern compose keys"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all suites, including `tests/reconcile.test.ts` and the merge-key test).

- [ ] **Step 6: Commit**

```bash
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: apply swarm reconciliation during compose reconcile"
```

---

### Task 10: Full pipeline, package, and docs

**Files:**
- Modify: `README.md` (the "How Compose Files Are Processed" section, ~lines 206-224)
- Regenerated: `dist/` (via `npm run package`)

- [ ] **Step 1: Document the behavior**

In `README.md`, under "How Compose Files Are Processed", add a short subsection describing that the action now translates modern compose keys (resource limits, `restart`, `depends_on`, `label_file`) to their swarm equivalents, strips unsupported keys (`develop`, `profiles`, `provider`, `models`, lifecycle hooks, `gpus`) with a warning, and that `strict-compatibility: true` turns those warnings into a hard failure. Keep to the file's 80-char line width (tables exempt).

- [ ] **Step 2: Run the full pipeline**

Run: `npm run all`
Expected: format, lint, typecheck, all tests, and package all pass; `dist/` is regenerated.

- [ ] **Step 3: Commit**

```bash
git add README.md dist/
git commit -m "docs: document compose→swarm reconciliation; rebuild dist"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/compose-swarm-reconciliation
gh pr create --title "feat: active Compose→Swarm reconciliation" --body "<summary + link to the design doc and the empirical stack config findings>"
```

---

## Self-Review

**Spec coverage:**
- §Architecture (new module, call site before stack config) → Task 2 + Task 9. ✓
- §1 Translation rules: `mem_limit`/`mem_reservation`/`cpus` → Task 3; `restart` → Task 4; `depends_on` → Task 5; `label_file` → Task 7. ✓
- §2 Strip-and-warn (incl. `provider` drops service, top-level `models`) → Task 6. ✓
- §3 Warn-only (`container_name`, `build`) → Task 2. ✓
- §4 Unknown-key validation + did-you-mean → Task 8. ✓
- §5 Strict mode (`strict-compatibility` input, aggregated throw) → Task 1 (input/setting) + Task 2 (aggregation). ✓
- §Testing (unit per rule, non-clobbering, path containment, strict) → covered across Tasks 2-8; integration test → Task 9. ✓
- §Out of scope (profiles resolution, include/extends, env_file, GPU translation, custom tags) → not implemented, as intended. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The only free-text deliverable is the PR body (Task 10 Step 4) and README prose (Task 10 Step 1), which are inherently narrative. ✓

**Type consistency:** `reconcileSwarmCompatibility(spec, settings): Promise<void>` is async throughout (Task 2 defines async; Tasks 3-8 add sync/async helpers within it; Task 9 `await`s it). `Diagnostics.warn/note/finish` names are used consistently. `ensurePath` (Task 3) is reused by Task 4. `withinWorkspace`/`parseEnvFile` (Task 7) and `closestKey`/`levenshtein`/`suggestion` (Task 8) are each defined once. Service casts use `Record<string, unknown>` consistently. ✓
