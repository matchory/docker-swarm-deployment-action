import { defineConfig } from "vitest/config";

// Scenarios in tests/swarm deploy to the swarm of the current Docker context
// and run the bundle in dist/. One file at a time, so that timing-sensitive
// monitoring scenarios don't compete for the node.
export default defineConfig({
  test: {
    include: ["tests/swarm/**/*.test.ts"],
    globalSetup: ["tests/swarm/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["verbose", "github-actions"],
  },
});
