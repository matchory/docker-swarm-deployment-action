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
});
