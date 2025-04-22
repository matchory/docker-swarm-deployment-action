import { defineBuildConfig } from "unbuild";
import packageJson from "./package.json" with { type: "json" };

const { name } = packageJson;

export default defineBuildConfig({
  entries: [
    {
      input: "./src/main.ts",
      format: "esm",
      ext: "js",
    },
    {
      input: "./src/index.ts",
      ext: "js",
    },
  ],
  name,
  sourcemap: true,
  externals: ["@actions/exec", "@actions/core", "@actions/io"],
});
