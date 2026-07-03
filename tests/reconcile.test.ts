import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import { reconcileSwarmCompatibility } from "../src/reconcile.js";

vi.mock("@actions/core");

const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile }));

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
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("build"),
      );
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
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("mem_limit"),
      );
    });
  });

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
        api: {
          image: "nginx",
          restart: "always",
          deploy: { restart_policy: { condition: "none" } },
        },
      });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect((s.services.api as { deploy: unknown }).deploy).toEqual({
        restart_policy: { condition: "none" },
      });
      expect(s.services.api).not.toHaveProperty("restart");
    });
  });

  describe("translate depends_on", () => {
    it("converts map form to a list and warns conditions are dropped", async () => {
      const s = spec({
        api: {
          image: "nginx",
          depends_on: {
            db: { condition: "service_healthy" },
            cache: { condition: "service_started" },
          },
        },
        db: { image: "postgres" },
        cache: { image: "redis" },
      });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect((s.services.api as { depends_on: unknown }).depends_on).toEqual([
        "db",
        "cache",
      ]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("depends_on"),
      );
    });

    it("leaves list form unchanged and does not warn", async () => {
      const s = spec({
        api: { image: "nginx", depends_on: ["db"] },
        db: { image: "postgres" },
      });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect((s.services.api as { depends_on: unknown }).depends_on).toEqual([
        "db",
      ]);
      expect(core.warning).not.toHaveBeenCalled();
    });
  });

  describe("strip-and-warn rules", () => {
    it.each([
      "develop",
      "post_start",
      "pre_stop",
      "profiles",
      "memswap_limit",
      "gpus",
    ])("strips %s and warns", async (key) => {
      const s = spec({ api: { image: "nginx", [key]: "x" } });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(s.services.api).not.toHaveProperty(key);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(key));
    });

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
      const s = {
        services: { api: { image: "nginx" } },
        models: { chat: {} },
      } as ComposeSpec;
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(s).not.toHaveProperty("models");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("models"),
      );
    });
  });

  describe("translate label_file", () => {
    it("merges label file entries into labels, existing labels winning", async () => {
      readFile.mockResolvedValue(
        "com.example.team=platform\ncom.example.env=prod\n",
      );
      const s = spec({
        api: {
          image: "nginx",
          label_file: "./labels.env",
          labels: { "com.example.env": "staging" },
        },
      });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(s.services.api).toEqual({
        image: "nginx",
        labels: {
          "com.example.env": "staging",
          "com.example.team": "platform",
        },
      });
    });

    it("rejects a label_file path that escapes the workspace", async () => {
      vi.stubEnv("GITHUB_WORKSPACE", "/work");
      const s = spec({ api: { image: "nginx", label_file: "../secrets.env" } });
      await reconcileSwarmCompatibility(s, { strictCompatibility: false });
      expect(readFile).not.toHaveBeenCalled();
      expect(s.services.api).not.toHaveProperty("label_file");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("outside the workspace"),
      );
    });
  });
});
