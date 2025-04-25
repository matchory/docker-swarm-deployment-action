import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exists, sleep } from "../src/utils.js";

const base = fileURLToPath(new URL(".", import.meta.url));

describe("Utilities", () => {
  describe("exists", () => {
    it("should return true for existing files", async () => {
      await expect(exists(`${base}/../package.json`)).resolves.toBe(true);
    });

    it("should return false for non-existing files", async () => {
      await expect(exists("some-missing-file.json")).resolves.toBe(false);
    });
  });

  describe("sleep", () => {
    it("should resolve after the specified time", async () => {
      const start = Date.now();
      await sleep(100);
      const end = Date.now();
      expect(end - start).toBeGreaterThanOrEqual(100);
    });

    it("should resolve immediately if time is 0", async () => {
      const start = Date.now();
      await sleep(0);
      const end = Date.now();
      expect(end - start).toBeLessThan(100);
    });
  });
});
