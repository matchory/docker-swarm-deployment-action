import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import { mergeComposeFiles } from "../src/engine.js";
import { reconcileSwarmCompatibility } from "../src/reconcile.js";

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

type Service = {
  deploy?: { replicas?: number; restart_policy?: unknown };
  restart?: unknown;
  labels?: Record<string, string>;
  label_file?: unknown;
  depends_on?: unknown;
};
type Secret = { name?: string; labels?: Record<string, string> };

// Run `fn` in a throwaway temp workspace. reconcile confines label_file to
// GITHUB_WORKSPACE, so we point it at the temp dir (the absolute path compose
// emits then falls inside it) and restore the environment afterwards. Each
// call gets its own directory, so cases can't contaminate one another.
async function withTempWorkspace<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-after-merge-"));
  const savedWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = dir;

  try {
    return await fn(dir);
  } finally {
    if (savedWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedWorkspace;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  it("deploy:!override + restart: both survive into deploy", async () => {
    await withTempWorkspace(async (dir) => {
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

      const web = spec.services.web as Service;
      expect(web.deploy?.replicas).toBe(3);
      expect(web.deploy?.restart_policy).toEqual({ condition: "any" });
      expect(web).not.toHaveProperty("restart");
    });
  });

  it("labels:!override + label_file: labels reconcile correctly", async () => {
    await withTempWorkspace(async (dir) => {
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

      const web = spec.services.web as Service;
      // !override replaced the labels map; label_file entries merge in under it.
      expect(web.labels).toEqual({ FROM_FILE: "filevalue", only: "this" });
      expect(web).not.toHaveProperty("label_file");
    });
  });

  it("depends_on:!override reconciles to a list", async () => {
    await withTempWorkspace(async (dir) => {
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

      const web = spec.services.web as Service;
      expect(web.depends_on).toEqual(["db"]);
    });
  });

  it("preserves an explicit secret name and labels through the merge", async () => {
    await withTempWorkspace(async (dir) => {
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

      const secret = (spec.secrets as Record<string, Secret>).my_secret;
      expect(secret.name).toBe("myapp-my_secret-abc1234");
      expect(secret.labels?.["com.matchory.deployment.stack"]).toBe("myapp");
    });
  });
});
