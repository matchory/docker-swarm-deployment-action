import { describe, expect, it } from "vitest";
import { assertOwnShares } from "../src/shares.js";

const spec = (volume: unknown) => ({
  services: { web: { image: "alpine:3.20" } },
  volumes: { data: volume },
});

describe("assertOwnShares", () => {
  it.each([
    [{ external: true, name: "other_shared" }],
    [{ external: true, name: "other_shared-v2" }],
    [{ name: "other_shared" }],
  ])("rejects another stack's share %j", (volume) => {
    expect(() => assertOwnShares(spec(volume), "web")).toThrow(/volume "data" names "other_shared/i);
  });

  it.each([
    [{ external: true, name: "web_shared" }],
    [{ external: true, name: "web_shared-v3" }],
    [{ external: true, name: "other_data" }],
    [{ driver: "local" }],
    [null],
  ])("accepts %j", (volume) => {
    expect(() => assertOwnShares(spec(volume), "web")).not.toThrow();
  });

  it("accepts a spec without volumes", () => {
    expect(() => assertOwnShares({ services: {} }, "web")).not.toThrow();
  });
});
