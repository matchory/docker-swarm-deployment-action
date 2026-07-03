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
});
