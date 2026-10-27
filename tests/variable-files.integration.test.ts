import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interpolateSpec,
  loadComposeSpecs,
  normalizeSpec,
} from "../src/compose.js";
import type { Settings } from "../src/settings.js";
import { removeGeneratedVariableFiles } from "../src/variables.js";

function composeAvailable(): boolean {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    execSync("docker stack config --help", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = composeAvailable() ? describe : describe.skip;

// Run the action's load and normalize steps against the real Docker CLI, with
// the compose files in `docker/` and the working directory at the project
// root, as on a runner, and return the secret files the interpolated spec uses.
async function normalizeSecretFiles(
  override: string,
  prefix = "variable-files-",
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const cwd = process.cwd();
  const savedWorkspace = process.env.GITHUB_WORKSPACE;

  mkdirSync(join(dir, "docker"));
  writeFileSync(
    join(dir, "docker", "compose.yaml"),
    "services:\n  web:\n    image: nginx\n    secrets: [db, api]\n" +
      "    deploy:\n      replicas: 1\n" +
      "secrets:\n  db:\n    environment: DB_PASSWORD\n" +
      "  api:\n    file: ./api.secret\n",
  );
  writeFileSync(join(dir, "docker", "compose.override.yaml"), override);
  writeFileSync(join(dir, "api.secret"), "api-key");

  const settings = {
    manageVariables: true,
    stack: "test",
    strictVariables: true,
    strictCompatibility: false,
    version: "1.0.0",
    envVarPrefix: "APP",
    variables: new Map([["DB_PASSWORD", "hunter2"]]),
  } as unknown as Settings;

  process.chdir(dir);
  process.env.GITHUB_WORKSPACE = dir;
  let generated: string | undefined;

  try {
    const prepared = await loadComposeSpecs(
      ["docker/compose.yaml", "docker/compose.override.yaml"],
      settings,
    );
    const spec = interpolateSpec(
      await normalizeSpec(prepared, settings),
      settings,
    );
    const files = Object.values(spec.secrets ?? {}).map(
      (secret) => (secret as { file: string }).file,
    );

    generated = files.find((file) => file.endsWith(".generated.secret"));

    return {
      dir,
      files,
      exist: files.map((file) => existsSync(file)),
      mode: generated && statSync(generated).mode & 0o777,
    };
  } finally {
    await removeGeneratedVariableFiles();
    const leftover = generated !== undefined && existsSync(generated);
    process.chdir(cwd);

    if (savedWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedWorkspace;
    }

    rmSync(dir, { recursive: true, force: true });

    // Cleanup must find the generated file by its absolute path. Asserted after
    // restoring state, so a failure here neither skips it nor masks an error
    // thrown above (where `generated` is still unset).
    expect(leftover).toBe(false);
  }
}

// Docker's first invocation on a fresh CI runner can take several seconds,
// so the default 5s per-test timeout is too tight for real CLI calls.
suite(
  "variable files with a compose file in a subdirectory",
  { timeout: 30_000 },
  () => {
    it("points at existing files on the merge-tag path", async () => {
      const { dir, files, exist, mode } = await normalizeSecretFiles(
        "services:\n  web:\n    deploy: !override\n      replicas: 2\n",
      );

      expect(files).toHaveLength(2);
      expect(exist).toEqual([true, true]);
      expect(files).toContain(join(dir, "api.secret"));
      expect(mode).toBe(0o600);
    });

    it("points at existing files on the tag-free path", async () => {
      const { dir, files, exist, mode } = await normalizeSecretFiles(
        "services:\n  web:\n    deploy:\n      replicas: 2\n",
      );

      expect(files).toHaveLength(2);
      expect(exist).toEqual([true, true]);
      expect(files).toContain(join(dir, "api.secret"));
      expect(mode).toBe(0o600);
    });
  },
);

suite(
  "variable files in a working directory containing a dollar sign",
  { timeout: 30_000 },
  () => {
    it("points at existing files after interpolation", async () => {
      const { dir, files, exist } = await normalizeSecretFiles(
        "services:\n  web:\n    deploy:\n      replicas: 2\n",
        "variable-files-$HOME-",
      );

      expect(dir).toContain("$HOME");
      expect(exist).toEqual([true, true]);
      expect(files).toContain(join(dir, "api.secret"));
    });
  },
);
