import { describe, expect, it, vi } from "vitest";

vi.mock("./main.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

describe("index", () => {
  it("should execute run() without error", async () => {
    const { run } = await import("./main.js");
    await expect(run()).resolves.toBeUndefined();
  });
});
