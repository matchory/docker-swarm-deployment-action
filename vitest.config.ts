import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs a swarm; run with vitest.swarm.config.ts
    exclude: [...configDefaults.exclude, "tests/swarm/**"],
    coverage: {
      enabled: true,
      include: ["src/**/*.ts"],
      reporter: ["json-summary", "text", "text-summary"],
      provider: "v8",
      reportOnFailure: true,
      allowExternal: false,
    },
    reporters: ["verbose", "github-actions"],
  },
});
