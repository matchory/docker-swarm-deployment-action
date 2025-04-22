import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      reporter: ["json-summary", "text", "text-summary"],
      provider: "v8",
      reportOnFailure: true,
    },
    reporters: ["verbose", "github-actions"],
  },
});
