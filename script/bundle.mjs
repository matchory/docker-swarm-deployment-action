// Bundles src/index.ts into the single-file ESM artifact the Actions runner
// loads as dist/index.js. Replaces @vercel/ncc, which cannot work with
// TypeScript 7: it drives the compiler through the TypeScript JS API, and
// TS 7 no longer ships one. esbuild parses TypeScript itself, so the
// typescript package is only a typechecker here.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { build } from "esbuild";

const root = dirname(import.meta.dirname);
const outDir = join(root, "dist");

// Matches LICENSE, LICENCE.md, COPYING, NOTICE.txt and the dashed variants
// packages split across licenses with, like LICENSE-MIT and LICENSE-APACHE.
const licenseFilePattern = /^(licence|license|copying|notice)([.-]|$)/i;

// Node applies source maps to stack traces only when asked, and only to
// modules compiled after the switch is flipped -- so the entry point the
// runner loads does nothing but flip it and pull in the bundle. ncc solved
// the same problem with a bundled copy of source-map-support.
const loader = [
  "process.setSourceMapsEnabled(true);",
  'await import("./main.js");',
  "",
].join("\n");

// Bundled CommonJS dependencies expect these to exist. esbuild rewrites
// static requires, but @actions/artifact reaches for createRequire and
// __dirname at runtime.
const cjsShim = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("\n");

const result = await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(outDir, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  metafile: true,
  legalComments: "none",
  banner: { js: cjsShim },
  write: false,

  // Node prints the raw generated line above a stack trace and does not
  // source-map it, so an unminified line length is what an uncaught error
  // dumps into the Actions log. Unbounded that is a quarter of a megabyte.
  lineLimit: 500,
});

const licenses = await collectLicenses(result);

// Nothing is removed until both the bundle and the license scan have
// succeeded, so a failure cannot leave the committed dist/ half deleted.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await Promise.all([
  ...result.outputFiles.map(({ path, contents }) => writeFile(path, contents)),
  writeFile(join(outDir, "index.js"), loader),
  writeFile(
    join(outDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  ),
  writeFile(join(outDir, "licenses.txt"), licenses),
]);

// Walks the packages esbuild actually pulled into the bundle and concatenates
// their license texts, reproducing what ncc's --license flag produced.
async function collectLicenses({ metafile }) {
  const packages = new Map();

  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageRootOf(input);

    if (dir && !packages.has(dir)) {
      packages.set(dir, await describePackage(dir));
    }
  }

  return [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      ({ name, license, text }) =>
        `${[name, license, text].filter(Boolean).join("\n")}\n`,
    )
    .join("\n");
}

// node_modules/foo/lib/x.js -> /abs/node_modules/foo, honouring @scope/name.
// Metafile paths are relative to the working directory, not to the repo root.
function packageRootOf(input) {
  const segments = resolve(input).split(sep);
  const index = segments.lastIndexOf("node_modules");

  if (index === -1) {
    return null;
  }

  const scoped = segments[index + 1]?.startsWith("@") ? 2 : 1;

  return segments.slice(0, index + 1 + scoped).join(sep);
}

async function describePackage(dir) {
  const manifest = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  );
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const texts = await Promise.all(
    files.map((file) => readFile(join(dir, file), "utf8")),
  );

  // Packages that ship no license file are still listed, with whatever their
  // manifest declares -- they are in the bundle and need attributing. ncc
  // emitted them the same way.
  return {
    name: manifest.name,
    license: licenseOf(manifest),
    text: texts.join("\n").trim(),
  };
}

function licenseOf({ license, licenses }) {
  if (typeof license === "string") {
    return license;
  }

  if (license?.type) {
    return license.type;
  }

  return licenses?.map(({ type }) => type).join(", ") ?? "UNKNOWN";
}
