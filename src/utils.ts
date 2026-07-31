import { access, constants, readdir, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as core from "@actions/core";

/**
 * Remove a generated file, warning instead of throwing if it cannot be removed:
 * it may hold a secret value that should not persist on a reused runner.
 *
 * @param path The path to remove
 * @param description How to refer to the file in the warning message
 */
export async function removeFileQuietly(path: string, description: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    core.warning(
      `Failed to remove ${description} "${path}": ${error}. ` +
        "It may contain a secret value and should be removed manually.",
    );
  }
}

/**
 * Check if a file or directory exists
 *
 * @param path The path to check
 */
export async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
  } catch {
    return false;
  }

  return true;
}

/**
 * Efficiently find the first existing file from a list of candidate paths
 * by grouping paths by directory and reading each directory only once.
 *
 * @param paths Array of file paths to check, in priority order
 * @returns The first existing file path, or null if none exist
 */
export async function findFirstExistingFile(
  paths: readonly string[],
): Promise<string | null> {
  // Group paths by their directory to minimize directory reads
  const pathsByDirectory = new Map<string, string[]>();

  for (const path of paths) {
    const directory = dirname(path);

    if (!pathsByDirectory.has(directory)) {
      pathsByDirectory.set(directory, []);
    }
    pathsByDirectory.get(directory)?.push(path);
  }

  // Read each directory once and cache the results
  const filesByDir = new Map<string, Set<string>>();

  for (const [directory] of pathsByDirectory) {
    try {
      const files = await readdir(directory);
      filesByDir.set(directory, new Set(files));
    } catch {
      // Directory doesn't exist or isn't readable
      filesByDir.set(directory, new Set());
    }
  }

  // Now check paths in priority order against cached directory contents
  for (const path of paths) {
    const directory = dirname(path);
    const fileName = basename(path);
    const filesInDir = filesByDir.get(directory);

    if (filesInDir?.has(fileName)) {
      return path;
    }
  }

  return null;
}

/**
 * Sleep for the specified number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rewrite every string in a value, returning a deep copy
 *
 * The JSON round-trip is both the traversal and the clone, so the input is
 * never mutated. Keys are left alone, as is anything that is not a string.
 *
 * @param value The value to copy
 * @param map Applied to each string encountered
 */
export function mapStrings<T>(value: T, map: (value: string) => string): T {
  return JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "string" ? map(item) : item,
    ),
  ) as T;
}

const variableRefPattern =
  /\$(?:([a-zA-Z_][a-zA-Z0-9_]*)|\{([a-zA-Z_][a-zA-Z0-9_]*)(?:(:?[-+?]|\?)[^{}]*)?})/gi;

/**
 * Extract all variable names referenced in a string.
 */
function extractVariableRefs(value: string): string[] {
  const refs: string[] = [];

  for (const match of value.matchAll(variableRefPattern)) {
    refs.push(match[1] || match[2]);
  }

  return refs;
}

/**
 * Detect circular references in the variable dependency graph reachable from
 * the given input string. Throws with the cycle path if one is found.
 */
function detectCycles(str: string, variables: Map<string, string>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(key: string, path: string[]): void {
    if (visited.has(key)) return;

    if (visiting.has(key)) {
      const cycleStart = path.indexOf(key);
      const cycle = [...path.slice(cycleStart), key].join(" → ");

      throw new Error(`Circular variable reference detected: ${cycle}`);
    }

    const value = variables.get(key);

    if (value === undefined) return;

    visiting.add(key);
    path.push(key);

    for (const ref of extractVariableRefs(value)) {
      visit(ref, path);
    }

    path.pop();
    visiting.delete(key);
    visited.add(key);
  }

  for (const ref of extractVariableRefs(str)) {
    visit(ref, []);
  }
}

/**
 * Interpolate a string with variables from a Map.
 *
 * This function interpolates a string with variables following the Bash-like syntax supported by Docker Compose.
 * It allows for different types of substitutions:
 *
 * - Default value substitution: `${VARIABLE_NAME:-default}` or `${VARIABLE_NAME-default}`
 *   If the variable is missing, it returns the default value.
 * - Alternative value substitution: `${VARIABLE_NAME:+default}` or `${VARIABLE_NAME+default}`
 *   If the variable is present, it returns the default value.
 * - Required value substitution: `${VARIABLE_NAME:?message}` or `${VARIABLE_NAME?message}`
 *   If the variable is missing, it throws an error quoting `message`, which explains why the
 *   variable is required. Unlike the other operators, the trailing text is not a default value.
 * - If the variable is present, it returns the variable's value.
 *
 * Further, it supports both `${VARIABLE_NAME}` and `$VARIABLE_NAME` formats, recursive interpolation, and escaping of
 * dollar signs (e.g., `$$VARIABLE_NAME` will become `$VARIABLE_NAME`).
 * When strict mode is enabled, it will throw an error if a variable is used, has no default value, and is not defined in
 * the variable map.
 *
 * @param str The string to interpolate
 * @param variables A Map of variable names to their values
 * @param [strict] If true, throw an error if a variable is used but not defined in the map
 */
export function interpolateString(
  str: string,
  variables: Map<string, string>,
  strict = false,
): string {
  // First, replace escaped dollar signs with a placeholder to protect them
  // during variable interpolation
  const placeholder = "\u0000ESCAPED_DOLLAR\u0000";
  str = str.replace(/\$\$/g, placeholder);

  detectCycles(str, variables);

  let match: RegExpMatchArray | null;

  type Operator = ":-" | ":+" | ":?" | "?" | "-" | "+";

  function resolveMatch(
    value: string | undefined,
    operator: Operator | undefined,
    defaultValue: string | undefined,
  ): string | undefined {
    if (
      // Default value substitution: If the variable is MISSING, return the
      // default value
      (operator === "-" && value === undefined) ||
      (operator === ":-" && !value) ||
      (operator === "+" && value !== undefined) ||
      (operator === ":+" && value)
    ) {
      return defaultValue ?? "";
    }

    // Alternative value substitution: If the variable is PRESENT, return
    // the default value, otherwise return an empty string
    if (operator === "+" || operator === ":+") {
      return "";
    }

    // Required value substitution: If the variable is MISSING, throw an error
    if (
      (operator === "?" && value === undefined) ||
      (operator === ":?" && !value)
    ) {
      // The text after `?`/`:?` is an explanatory message written by the
      // Compose file author, not a default value. Without one, point at the
      // places a value can come from rather than trailing off after a colon.
      throw new Error(
        defaultValue
          ? `it is required but has no value: ${defaultValue}`
          : `it is required but has no value. Set it via the "variables" ` +
              `or "secrets" input, or in the workflow environment.`,
      );
    }

    return value;
  }

  do {
    // Match the next variable in the string in any of the following formats:
    //  1. `$VAR`
    //  2. `${VAR}`
    //  3. `${VAR:-default}`
    //  4. `${VAR-default}`
    //  5. `${VAR:+default}`
    //  6. `${VAR+default}`
    //  7. `${VAR:?default}`
    //  8. `${VAR?default}`
    match = str.match(
      /\$(?:([a-zA-Z_][a-zA-Z0-9_]*)|\{([a-zA-Z_][a-zA-Z0-9_]*)(?:(:?[-+?]|\?)([^{}]*))?})/i,
    );

    // If we don't have any more matches, break out of the loop. This can happen
    // if we have replaced all variables in the string, and the match variable
    // was still populated with the last match.
    if (!match) {
      break;
    }

    const [fullMatch, key1, key2, operator, defaultValue] = match;
    const key = key1 || key2;
    const value = variables.get(key);
    let replacement: string | undefined;

    try {
      replacement = resolveMatch(value, operator as Operator, defaultValue);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      throw new Error(`Failed to resolve variable ${key}: ${message}`, {
        cause,
      });
    }

    if (strict && replacement === undefined) {
      throw new Error(
        `Variable "${key}" is not defined. Set it via the "variables" or ` +
          `"secrets" input, or in the workflow environment, or set ` +
          `"strict-variables: false" to substitute an empty string instead.`,
      );
    }

    str = str.replace(fullMatch, replacement ?? "");
  } while (match);

  // Finally, replace the placeholder back with single dollar signs
  str = str.replace(new RegExp(placeholder, "g"), "$");

  return str;
}

/**
 * Calculate the Levenshtein distance between two strings.
 *
 * @param a
 * @param b
 */
export function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);

  for (let j = 1; j <= b.length; j++) {
    rows[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }

  return rows[a.length][b.length];
}
