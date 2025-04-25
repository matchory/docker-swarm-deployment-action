import { defineBuildConfig } from "unbuild";
import packageJson from "./package.json" with { type: "json" };

const { name } = packageJson;

export default defineBuildConfig({
  name,
  parallel: true,
  outDir: "out",
  failOnWarn: false,
  externals: [],
  rollup: {
    preserveDynamicImports: false,
    emitCJS: true,
    cjsBridge: true,
    inlineDependencies: true,
    esbuild: {
      minify: false,
      target: "node22",
    },
    output: {
      sourcemap: "inline",
    },
    resolve: {
      preferBuiltins: true,
    },
  },
  sourcemap: true,
  declaration: false,
});
