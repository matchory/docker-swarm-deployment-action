import { defineConfig } from "vitest/config";

// Records the traces in tests/traces/fixtures on the swarm of the current
// Docker context; see tests/traces/record.trace.ts
export default defineConfig({
  test: {
    include: ["tests/traces/record.trace.ts"],
    globalSetup: ["tests/swarm/global-setup.ts"],
    reporters: ["verbose"],
  },
});
