// Bundles src/index.ts into the single-file ESM artifact the Actions runner
// loads as dist/index.js. Replaces @vercel/ncc, which cannot work with
// TypeScript 7: it drives the compiler through the TypeScript JS API, and
// TS 7 no longer ships one. esbuild parses TypeScript itself, so the
// typescript package is only a typechecker here.

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { build } from "esbuild";

const root = dirname(import.meta.dirname);
const outDir = join(root, "dist");
const licenseFilePattern = /^(licence|license|copying|notice)(\.|$)/i;

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
].join("");

await rm(outDir, { recursive: true, force: true });

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
});

await writeFile(join(outDir, "index.js"), loader);

await writeFile(
  join(outDir, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

await writeFile(join(outDir, "licenses.txt"), await collectLicenses(result));

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
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, license, text }) => `${name}\n${license}\n${text}\n`)
    .join("\n");
}

// node_modules/foo/lib/x.js -> node_modules/foo, honouring @scope/name.
function packageRootOf(input) {
  const segments = relative(root, join(root, input)).split(sep);
  const index = segments.lastIndexOf("node_modules");

  if (index === -1) {
    return null;
  }

  const scoped = segments[index + 1]?.startsWith("@") ? 2 : 1;

  return segments.slice(0, index + 1 + scoped).join(sep);
}

async function describePackage(dir) {
  const absolute = join(root, dir);
  const manifest = JSON.parse(
    await readFile(join(absolute, "package.json"), "utf8"),
  );
  const entries = await readdir(absolute);
  const files = entries
    .filter((entry) => licenseFilePattern.test(entry))
    .sort();
  const texts = await Promise.all(
    files.map((file) => readFile(join(absolute, file), "utf8")),
  );
  const text = texts.join("\n").trim();

  if (!text) {
    return null;
  }

  return {
    name: manifest.name,
    license: licenseOf(manifest),
    text,
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
