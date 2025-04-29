import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
