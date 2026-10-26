import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ComposeSpec } from "./compose.js";
import { containsOverrideTag, Tagged } from "./override-tags.js";
import type { Settings } from "./settings.js";
import { interpolateString, warnAboutUndefinedVariables } from "./utils.js";

/**
 * Inline every service's `env_file` entries into its `environment`
 *
 * `docker stack config` copies env file lines into `environment` verbatim,
 * quotes included, where `interpolateSpec` can no longer tell them apart from
 * entries written in the Compose file. So the env files are read here, before
 * normalization, following Compose's rules: explicit `environment` entries in
 * any file win over env files, later env files win over earlier ones, and
 * values are parsed and interpolated as compose-go's `dotenv` package does.
 * The inlined values have every `$` escaped, so `interpolateSpec` restores
 * them instead of interpolating them a second time.
 *
 * @param prepared The prepared Compose specifications, in merge order
 * @param settings The settings to use for the deployment
 * @param onUndefined Called with the name of each undefined variable used
 */
export async function inlineEnvFiles(
  prepared: Array<{ spec: ComposeSpec; baseDir: string }>,
  { variables }: Pick<Readonly<Settings>, "variables">,
  onUndefined = warnAboutUndefinedVariables(),
) {
  // Docker resolved relative paths against the first generated file, which the
  // merge-tag path writes beside the first Compose file and the tag-free path
  // writes to the working directory (see `normalizeSpec`).
  const baseDir = prepared.some(({ spec }) => containsOverrideTag(spec))
    ? prepared[0].baseDir
    : ".";
  const names = new Set(
    prepared.flatMap(({ spec }) => fieldsOf(spec.services)?.keys() ?? []),
  );

  for (const name of names) {
    const explicit = new Map<string, string | null>();
    let files: Array<{ path: string; required: boolean }> = [];
    let owner: Fields | undefined;

    // Replay the merge Docker will do, so the env files and explicit entries
    // of all files are known before any value is resolved.
    for (const { spec } of prepared) {
      const node = fieldsOf(spec.services)?.get(name);

      // A merge tag on the services or the service discards earlier files.
      if (spec.services instanceof Tagged || node instanceof Tagged) {
        explicit.clear();
        files = [];
      }

      const service = isReset(node) ? undefined : fieldsOf(node);

      if (!service) {
        continue;
      }

      owner = service;
      const envFile = service.get("env_file");
      const environment = service.get("environment");

      if (envFile instanceof Tagged) {
        files = [];
      }

      if (!isReset(envFile)) {
        for (const entry of [unwrap(envFile) ?? []].flat()) {
          const { path, required } =
            typeof entry === "string"
              ? { path: entry, required: true }
              : (entry as { path: string; required?: boolean });

          files.push({
            path: resolve(
              baseDir,
              interpolateString(path, variables, false, onUndefined),
            ),
            required: required !== false,
          });
        }
      }

      service.delete("env_file");

      if (environment instanceof Tagged) {
        explicit.clear();
      }

      if (!isReset(environment)) {
        for (const [key, value] of environmentEntries(unwrap(environment))) {
          explicit.set(key, value);
        }
      }
    }

    if (!owner || files.length === 0) {
      continue;
    }

    // Like Compose, resolve the explicit entries first: env files may refer
    // to them, after the variables.
    const resolved = new Map<string, string>();

    for (const [key, value] of explicit) {
      const result =
        value === null
          ? variables.get(key)
          : interpolateString(value, variables, false);

      if (result !== undefined) {
        resolved.set(key, result);
      }
    }

    const lookup = new Map([...resolved, ...variables]);
    const values = new Map(resolved);

    for (const { path, required } of files) {
      let content: string;

      try {
        content = await readFile(path, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          throw cause;
        }

        if (!required) {
          continue;
        }

        throw new Error(
          `Service "${name}": env_file "${path}" not found. Create it, or ` +
            `make it optional with "required: false".`,
          { cause },
        );
      }

      try {
        parseEnvFile(content, values, lookup, onUndefined);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        throw new Error(
          `Service "${name}": failed to read env_file "${path}": ${message}`,
          { cause },
        );
      }
    }

    const inlined = [...values]
      .filter(([key]) => !explicit.has(key))
      .map(([key, value]) => [key, value.replaceAll("$", () => "$$")]);

    addEnvironment(owner, inlined as Array<[string, string]>);
  }
}

// Add entries to a service's `environment`, which holds none of their keys,
// keeping its form and any merge tag that applies to earlier files.
function addEnvironment(service: Fields, entries: Array<[string, string]>) {
  if (entries.length === 0) {
    return;
  }

  const environment = service.get("environment");

  if (isReset(environment)) {
    service.set(
      "environment",
      new Tagged("!override", "mapping", new Map(entries)),
    );
  } else if (Array.isArray(unwrap(environment))) {
    (unwrap(environment) as string[]).push(
      ...entries.map(([key, value]) => `${key}=${value}`),
    );
  } else if (fieldsOf(environment)) {
    for (const [key, value] of entries) {
      fieldsOf(environment)?.set(key, value);
    }
  } else {
    service.set("environment", Object.fromEntries(entries));
  }
}

function environmentEntries(value: unknown): Array<[string, string | null]> {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const [key, ...rest] = String(item).split("=");

      return [key, rest.length > 0 ? rest.join("=") : null];
    });
  }

  const entries =
    value instanceof Map
      ? [...value]
      : value && typeof value === "object"
        ? Object.entries(value)
        : [];

  return entries.map(([key, item]) => [
    String(key),
    item === null || item === undefined ? null : String(item),
  ]);
}

function isReset(value: unknown) {
  return value instanceof Tagged && value.tag === "!reset";
}

function unwrap(value: unknown) {
  return value instanceof Tagged ? value.value : value;
}

type Fields = {
  keys(): string[];
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
};

// Access a mapping that may be wrapped in a merge tag, which holds a `Map`.
function fieldsOf(node: unknown): Fields | undefined {
  const value = unwrap(node);

  if (value instanceof Map) {
    return {
      keys: () => [...value.keys()].map(String),
      get: (key) => value.get(key),
      set: (key, item) => value.set(key, item),
      delete: (key) => value.delete(key),
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  return {
    keys: () => Object.keys(record),
    get: (key) => record[key],
    set: (key, item) => {
      record[key] = item;
    },
    delete: (key) => {
      delete record[key];
    },
  };
}

/**
 * Parse an env file into `values`, following compose-go's `dotenv` parser
 *
 * Unquoted and double-quoted values are interpolated, looking variables up in
 * `lookup` first and then in `values`, which holds the explicit entries and
 * the earlier keys of all env files. Single-quoted values are literal, and
 * double-quoted ones expand escape sequences first. A key without a value is
 * taken from `lookup`, or omitted if it is not there.
 *
 * @param content The content of the env file
 * @param values The values parsed so far, which the file adds to
 * @param lookup The variables that take precedence when interpolating
 * @param onUndefined Called with the name of each undefined variable used
 * @see https://github.com/compose-spec/compose-go/blob/main/dotenv/parser.go
 */
export function parseEnvFile(
  content: string,
  values: Map<string, string>,
  lookup: Map<string, string>,
  onUndefined?: (name: string) => void,
) {
  const src = content.replace(/^\uFEFF/, "");
  let line = 1;
  let pos = 0;

  const fail = (message: string): never => {
    throw new Error(`line ${line}: ${message}`);
  };
  const expand = (value: string) =>
    interpolateString(
      value,
      new Map([...values, ...lookup]),
      false,
      onUndefined,
    );

  while (true) {
    // Skip whitespace and comment lines up to the next statement.
    for (; pos < src.length; pos++) {
      if (src[pos] === "\n") {
        line++;
      } else if (src[pos] === "#") {
        const end = src.indexOf("\n", pos);
        pos = end === -1 ? src.length : end - 1;
      } else if (!/\s/.test(src[pos])) {
        break;
      }
    }

    if (pos >= src.length) {
      return;
    }

    const exported = /^export[\t\n\f\r ]+/.exec(src.slice(pos));

    if (exported) {
      pos = skipSpaces(src, pos + "export".length);
    }

    // Find the end of the key: `=`, the YAML-style `:`, or a line break (or
    // the end of the file) for a key without a value.
    let end = pos;
    let inherited = true;

    for (const char of src.slice(pos)) {
      if (char === "=" || char === ":" || char === "\n") {
        inherited = char === "\n";
        break;
      }

      if (!isSpace(char) && !/^[\p{L}\p{N}_.\-[\]]$/u.test(char)) {
        fail(
          `unexpected character "${char}" in variable name ` +
            `"${src.slice(pos).split("\n")[0]}"`,
        );
      }

      end += char.length;
    }

    const key = src.slice(pos, end).trimEnd();
    pos = skipSpaces(src, end + 1);

    if (key === "") {
      fail("key cannot be empty");
    }

    if (key.includes(" ")) {
      fail("key cannot contain a space");
    }

    if (inherited) {
      line++;
      const value = lookup.get(key);

      if (value !== undefined) {
        values.set(key, value);
      }

      continue;
    }

    const quote = src[pos];

    if (quote !== "'" && quote !== '"') {
      const newline = src.indexOf("\n", pos);
      const raw = src.slice(pos, newline === -1 ? src.length : newline);
      pos = newline === -1 ? src.length : newline + 1;
      line++;

      values.set(key, expand(raw.split(" #")[0].trimEnd()));
      continue;
    }

    // Read up to the closing quote. A backslash escapes the quote; any other
    // escape is kept for `expandEscapes`.
    const start = pos;
    let value = "";
    let escaped = false;
    let closed = false;

    for (pos++; pos < src.length; pos++) {
      const char = src[pos];

      if (char === "\n") {
        line++;
      }

      if (char === quote && !escaped) {
        closed = true;
        pos++;
        break;
      }

      if (char === "\\" && !escaped) {
        escaped = true;
        continue;
      }

      value += escaped && char !== quote ? `\\${char}` : char;
      escaped = false;
    }

    if (!closed) {
      fail(`unterminated quoted value ${src.slice(start).split("\n")[0]}`);
    }

    values.set(key, quote === '"' ? expand(expandEscapes(value)) : value);
  }
}

// The escape sequences compose-go expands in double-quoted values. `\$` maps
// to `$$`, which interpolation turns into a literal `$`.
const escapes: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  $: "$$",
  '"': '"',
  "\\": "\\",
};

function expandEscapes(value: string) {
  return value.replace(/\\(?:[abcfnrtv$"\\]|0\d{0,3})/g, (match) => {
    // `\0` is followed by up to three digits; only three octal digits up to
    // 255 form a character, like Go's `strconv.UnquoteChar`.
    if (match[1] === "0") {
      const digits = match.slice(2);

      return /^[0-7]{3}$/.test(digits) && Number.parseInt(digits, 8) <= 255
        ? String.fromCharCode(Number.parseInt(digits, 8))
        : match;
    }

    return escapes[match[1]] ?? match;
  });
}

// Spaces other than line breaks, as in compose-go.
function isSpace(char: string) {
  return /^[\t\v\f\r \u0085\u00A0]$/.test(char);
}

function skipSpaces(src: string, pos: number) {
  while (pos < src.length && isSpace(src[pos])) {
    pos++;
  }

  return pos;
}
