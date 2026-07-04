import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { debug } from "node:util";
import * as core from "@actions/core";
import { CORE_SCHEMA, dump, load, mergeTag } from "js-yaml";
import {
  isComposePluginAvailable,
  mergeComposeFiles,
  normalizeStackSpecification,
} from "./engine";
import {
  containsOverrideTag,
  overrideTagDefinitions,
  Tagged,
} from "./override-tags.js";
import { reconcileSwarmCompatibility } from "./reconcile.js";
import type { Settings } from "./settings.js";
import { exists, findFirstExistingFile, interpolateString } from "./utils.js";
import { processVariable, type Variable } from "./variables.js";

export const schemaVersion = "3.9";

/**
 * YAML schema used to parse Compose files.
 *
 * js-yaml v5 dropped merge keys (`<<:`) from its default CORE_SCHEMA because
 * they were removed from the YAML spec back in 2009. Compose files rely on
 * them heavily to share fragments between services via anchors/aliases, so we
 * re-enable the tag here. Without it, `<<` is parsed as a literal map key and
 * the anchored fragment is silently nested instead of merged.
 *
 * @see https://github.com/nodeca/js-yaml/issues/646
 */
export const composeSchema = CORE_SCHEMA.withTags(
  mergeTag,
  ...overrideTagDefinitions,
);

export const defaultVariants = [
  "compose.production.yaml",
  "compose.production.yml",
  "compose.prod.yaml",
  "compose.prod.yml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.production.yaml",
  "docker-compose.production.yml",
  "docker-compose.prod.yaml",
  "docker-compose.prod.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  join(".docker", "compose.yaml"),
  join(".docker", "compose.yml"),
  join(".docker", "docker-compose.yaml"),
  join(".docker", "docker-compose.yml"),
  join("docker", "compose.yaml"),
  join("docker", "compose.yml"),
  join("docker", "docker-compose.yaml"),
  join("docker", "docker-compose.yml"),
] as const;

/**
 * Resolves the Docker Compose File path
 *
 * This function checks if the user has specified any Compose Files explicitly
 * in the settings. If so, it checks if those files exist and are readable.
 * If any of the specified files are missing, it throws an error and aborts
 * the deployment.
 * If no Compose Files are specified, it checks common default locations
 * for the Compose File to deploy, using the first one it finds.
 * If neither the specified nor the default Compose Files are found, it throws
 * an error and aborts the deployment.
 */
export async function resolveComposeFiles(
  settings: Readonly<Settings>,
): Promise<readonly [string, ...string[]]> {
  debug(`Resolving Compose File from ${settings.composeFiles}`);

  // If the user has specified any Compose Files explicitly, we check those and
  // bail if any is missing. This avoids accidentally deploying a stack with
  // the wrong Compose File; e.g., if the config file specifies
  // "docker-compose.staging.yml", but the file is actually named
  // "docker-compose.staging.yaml" (with an "a"), and there is also a production
  // config at "docker-compose.production.yaml", we would end up deploying the
  // production stack to a staging environment, possibly wreaking havoc.
  // So instead, we check if the files exist and are readable, and if not, we
  // throw an error and abort the deployment.
  if (settings.composeFiles && settings.composeFiles.length > 0) {
    // Validate that all specified paths resolve within the workspace to
    // prevent path traversal attacks (e.g., "../../etc/passwd").
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const resolvedWorkspace = resolve(workspace);
    const prefix = resolvedWorkspace.endsWith("/")
      ? resolvedWorkspace
      : `${resolvedWorkspace}/`;
    const escapedPaths = settings.composeFiles.filter(
      (path) =>
        resolve(path) !== resolvedWorkspace &&
        !resolve(path).startsWith(prefix),
    );

    if (escapedPaths.length > 0) {
      throw new Error(
        `One or more Compose Files resolve outside the workspace ` +
          `directory: ${escapedPaths.join(", ")}`,
      );
    }

    const files = await Promise.all(
      settings.composeFiles.map((path) => exists(path)),
    );

    if (!files.every(Boolean)) {
      // Assemble a list of all missing files to include in the error message.
      const missing = files
        .map((exists, index) =>
          !exists ? settings.composeFiles?.[index] : undefined,
        )
        .filter((file) => file !== undefined);

      throw new Error(
        `One or more Compose Files specified in the configuration are ` +
          `missing or not readable: ${missing.join(", ")}`,
      );
    }

    // At least one file is specified
    return settings.composeFiles as [string, ...string[]];
  }

  // If no Compose Files are specified, we check several default locations for
  // the Compose File to deploy, using the first one we find. This allows users
  // to use the action without having to specify a Compose File, as long as they
  // follow the naming conventions outlined in the documentation.
  const foundFile = await findFirstExistingFile(defaultVariants);

  if (foundFile) {
    core.info(`Found Compose File at "${foundFile}"`);
    return [foundFile] as const;
  }

  // We couldn't find any Compose Files, so we throw an error and abort the
  // deployment early.
  throw new Error(
    `Could not find a Compose file to deploy. The "compose-file" input was ` +
      `not set, and none of the default locations contain one (e.g. ` +
      `compose.yaml, docker-compose.yaml, .docker/compose.yaml, ` +
      `docker/compose.yaml). Add a Compose file at one of those paths, or ` +
      `set the "compose-file" input to its path.`,
  );
}

/**
 * Loads and normalizes the Compose specification
 *
 * This function loads the Compose specification(s) from all specified or
 * discovered Compose Files, reconciles the specification to the legacy Compose
 * file version 3 format, and resolves all referenced variables.
 * It returns a set of normalized Compose specification objects that will be
 * usable to docker stack commands.
 */
export async function loadComposeSpecs(
  composeFiles: Readonly<Array<string>>,
  settings: Readonly<Settings>,
) {
  const specs = [];

  for (const filename of composeFiles) {
    specs.push(await loadComposeSpec(filename, settings));
  }

  return specs;
}

async function loadComposeSpec(filename: string, settings: Settings) {
  const content = await readFile(filename, "utf8");
  const parsedContent = load(content, {
    filename,
    schema: composeSchema,
  }) as ComposeSpec;

  const spec = await prepareSpec(parsedContent, settings, filename);

  return { spec, baseDir: dirname(filename) };
}

/**
 * Prepare a parsed Compose spec for merging: normalize top-level shape and
 * convert `content:`/`environment:` secrets and configs to files. This is the
 * only transform that must run before either Docker merge tool sees the spec.
 * Swarm reconciliation runs later, in `normalizeSpec`, on the merged output.
 */
export async function prepareSpec(
  composeSpec: ComposeSpec,
  settings: Settings,
  filename?: string,
) {
  if (composeSpec.name) {
    delete composeSpec.name;
  }

  if (!composeSpec.version) {
    composeSpec.version = schemaVersion;
  }

  if (!composeSpec.services || Object.keys(composeSpec.services).length === 0) {
    const where = filename ? `Compose file "${filename}"` : "The Compose file";

    throw new Error(
      `${where} has no services to deploy: its "services:" section is ` +
        `missing or empty. A stack needs at least one service. Add a ` +
        `"services:" block, or point the "compose-file" input at the ` +
        `correct file.`,
    );
  }

  if (settings.manageVariables) {
    if (composeSpec.secrets) {
      assertNoMergeTags("secret", "secrets", composeSpec.secrets);
      core.startGroup("Processing secrets");

      for (const [name, entry] of Object.entries(composeSpec.secrets)) {
        composeSpec.secrets[name] = await processVariable(
          name,
          entry,
          settings,
        );
      }

      core.endGroup();
    }

    if (composeSpec.configs) {
      assertNoMergeTags("config", "configs", composeSpec.configs);
      core.startGroup("Processing configs");

      for (const [name, entry] of Object.entries(composeSpec.configs)) {
        composeSpec.configs[name] = await processVariable(
          name,
          entry,
          settings,
        );
      }

      core.endGroup();
    }
  }

  return composeSpec;
}

// A `!reset`/`!override` merge tag on a top-level secret/config carrier reaches
// here as a `Tagged` value. `processVariable` can't interpret it and would fail
// with a misleading "not defined in the environment" error, so we detect it
// first and explain the real cause: managed variables are resolved before
// Docker merges the files, leaving no merged value for the tag to apply to.
function assertNoMergeTags(
  kind: "secret" | "config",
  section: "secrets" | "configs",
  entries: Record<string, Variable>,
): void {
  // Tag on the entire `secrets:` / `configs:` mapping.
  if (entries instanceof Tagged) {
    throwMergeTagError(kind, `The "${section}:" section`, entries.tag);
  }

  // Tag on an individual entry.
  for (const [name, entry] of Object.entries(entries)) {
    if (entry instanceof Tagged) {
      const label = kind === "secret" ? "Secret" : "Config";
      throwMergeTagError(kind, `${label} "${name}"`, entry.tag);
    }
  }
}

function throwMergeTagError(
  kind: "secret" | "config",
  subject: string,
  tag: string,
): never {
  throw new Error(
    `${subject} uses the "${tag}" merge tag, but merge tags are not ` +
      `supported on ${kind}s while variable management is enabled ` +
      `(manage-variables: true). The action resolves each ${kind}'s value ` +
      `before Docker merges the Compose files, so there is no merged value ` +
      `for the tag to apply to. Remove the "${tag}" tag from this ${kind}, ` +
      `or set "manage-variables: false" to let Docker apply the merge tags ` +
      `itself.`,
  );
}

/**
 * Normalize the Compose specification
 *
 * This function takes multiple Compose specifications and merges them into a
 * single configuration. This works by delegating the merging to the `docker
 * stack config` command, which will:
 *  - validate the Compose Files according to the docker stack specification,
 *  - merge them into a single, canonical configuration object, and
 *  - resolve all shorthand options to their full form.
 *
 * This process allows users to write Compose Spec files—which would normally
 * not be compatible with the stack specification—while still being able
 * to deploy them to Swarm.
 *
 * @param prepared The Compose specifications to normalize, each paired with
 *   the base directory it was loaded from
 * @param settings The settings to use for the deployment
 */
export async function normalizeSpec(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  const spec = prepared.some((item) => containsOverrideTag(item.spec))
    ? await mergeThenReconcile(prepared, settings)
    : await reconcileThenMerge(prepared, settings);

  if (!spec?.services || Object.keys(spec.services).length === 0) {
    throw new Error(
      `The merged Compose specification contains no services to deploy. ` +
        `Ensure your Compose file(s) define at least one service under ` +
        `"services:".`,
    );
  }

  return spec;
}

// Write a spec to a uniquely-named temp file in `dir`, so the docker merge tool
// that reads it resolves the spec's relative paths against that directory.
async function writeSpecFile(spec: ComposeSpec, dir: string): Promise<string> {
  const file = join(dir, `docker-compose.generated.${randomUUID()}.yaml`);
  await writeFile(file, dump(spec, { schema: composeSchema }));
  return file;
}

// Non-tag path: reconcile each spec (with its own base directory), then let
// `docker stack config` merge and normalize them — the pre-rework flow.
async function reconcileThenMerge(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  for (const { spec, baseDir } of prepared) {
    await reconcileSwarmCompatibility(spec, settings, baseDir);
    assertServicesRemain(spec);
  }

  // Write to the working directory (not baseDir) to preserve the released
  // behavior: `docker stack config` resolves any remaining relative paths
  // (env_file, secrets `file:`) against the generated file's location, and
  // reconcile has already inlined label_file with the correct baseDir above.
  const files = await Promise.all(
    prepared.map(({ spec }) => writeSpecFile(spec, ".")),
  );

  try {
    return await normalizeStackSpecification(files, settings, true);
  } finally {
    await Promise.all(files.map((path) => unlink(path)));
  }
}

// Tag path: merge with `docker compose config` (which honors the
// !reset/!override tags and emits a tag-free spec), reconcile the merged
// spec for Swarm, then normalize via `docker stack config`.
async function mergeThenReconcile(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  settings: Readonly<Settings>,
) {
  if (!(await isComposePluginAvailable())) {
    throw new Error(
      'Compose file uses the "!reset"/"!override" merge tags, which ' +
        "require the Docker Compose v2 plugin ('docker compose') on the " +
        "runner. Install it (it ships with GitHub-hosted runners) or " +
        "inline the override.",
    );
  }

  // Write each spec beside the compose file it came from so `docker compose
  // config` resolves its relative paths (env_file, label_file) against the
  // right directory. Unlike the non-tag path, reconcile has not run yet, so
  // label_file is still relative here and must resolve during the merge.
  const tempFiles = await Promise.all(
    prepared.map(({ spec, baseDir }) => writeSpecFile(spec, baseDir)),
  );

  try {
    const merged = await mergeComposeFiles(tempFiles);
    const mergedSpec = load(merged, {
      filename: "docker-compose.merged.yaml",
      json: true,
    }) as ComposeSpec;

    // `docker compose config` stamps a project name derived from the working
    // directory; drop it to match the tag-free path, where prepareSpec removes
    // the name from every input before merging.
    delete mergedSpec.name;

    await reconcileSwarmCompatibility(mergedSpec, settings);
    assertServicesRemain(mergedSpec);

    // The merged spec carries only absolute paths, so its directory no longer
    // matters; write it in the working directory.
    const mergedFile = `docker-compose.merged.${randomUUID()}.yaml`;
    await writeFile(mergedFile, dump(mergedSpec, { schema: composeSchema }));
    tempFiles.push(mergedFile);

    return await normalizeStackSpecification([mergedFile], settings, true);
  } finally {
    await Promise.all(tempFiles.map((path) => unlink(path)));
  }
}

function assertServicesRemain(spec: ComposeSpec) {
  if (Object.keys(spec.services).length === 0) {
    throw new Error(
      "All services were removed during reconciliation because they use " +
        "features Docker Swarm cannot run (e.g. provider services); " +
        "nothing to deploy.",
    );
  }
}

/**
 * Interpolate variables in the Compose specification
 *
 * This function interpolates variables in the Compose specification, following
 * the Compose Spec interpolation rules, with an optional exception: While
 * Compose does not support interpolation of variables within keys, this can be
 * optionally enabled by the `keyInterpolation` setting.
 * This means that `$FOO: $BAR` will be replaced with `foo: bar` if enabled,
 * while it would remain as `$FOO: bar` if disabled, leaving the key untouched.
 *
 * @param composeSpec The Compose specification to interpolate
 * @param keyInterpolation Whether to interpolate variables in keys
 * @param variables The variables to use for interpolation
 */
export function interpolateSpec(
  composeSpec: ComposeSpec,
  {
    keyInterpolation,
    variables,
  }: Pick<Readonly<Settings>, "variables" | "keyInterpolation">,
) {
  const spec = keyInterpolation
    ? interpolateString(JSON.stringify(composeSpec), variables)
    : JSON.stringify(composeSpec, (_, value) =>
        typeof value === "string" ? interpolateString(value, variables) : value,
      );

  return JSON.parse(spec) as ComposeSpec;
}

export function defineComposeSpec<T extends ComposeSpec>(spec: T) {
  return spec;
}

/**
 * Poor Man's Docker Compose specification
 */
export interface ComposeSpec {
  version?: string;
  services: Record<string, unknown>;
  secrets?: Record<string, Variable>;
  configs?: Record<string, Variable>;

  [key: string]: unknown;
}
