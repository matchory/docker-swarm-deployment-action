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
 * Further, it supports both `${VARIABLE_NAME}` and `$VARIABLE_NAME` formats, nested references in default and
 * alternative values (e.g., `${FOO:-${BAR}}`), and escaping of dollar signs (e.g., `$$VARIABLE_NAME` will become
 * `$VARIABLE_NAME`).
 * Like Compose, it substitutes in a single pass: substituted values are never interpolated again, so a `$` in a
 * variable's value is kept literally.
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
      // Only the default text itself is interpolated, and only when used
      return interpolateString(defaultValue ?? "", variables, strict);
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

  // Match the next variable or escape at the current position in any of the
  // following formats:
  //  1. `$$` (an escaped dollar sign)
  //  2. `$VAR`
  //  3. `${VAR}`
  //  4. `${VAR` followed by an operator: `:-`, `-`, `:+`, `+`, `:?` or `?`
  const pattern =
    /\$(?:(\$)|([a-zA-Z_][a-zA-Z0-9_]*)|\{([a-zA-Z_][a-zA-Z0-9_]*)(?:\}|(:?[-+?])))/y;
  let result = "";
  let index = 0;

  while (index < str.length) {
    const dollar = str.indexOf("$", index);

    if (dollar === -1) {
      break;
    }

    result += str.slice(index, dollar);
    pattern.lastIndex = dollar;
    const match = pattern.exec(str);
    let end = match ? pattern.lastIndex : -1;
    let defaultValue: string | undefined;

    // An operator is followed by a default value that may contain nested
    // `${...}` references, so find its closing brace by counting them.
    if (match?.[4]) {
      let depth = 1;

      for (; end < str.length; end++) {
        if (str.startsWith("${", end)) {
          depth++;
          end++;
        } else if (str[end] === "}" && --depth === 0) {
          break;
        }
      }

      defaultValue = str.slice(pattern.lastIndex, end);
      end = depth === 0 ? end + 1 : -1;
    }

    // Not a valid reference: keep the dollar sign literally and move on
    if (!match || end === -1) {
      result += "$";
      index = dollar + 1;
      continue;
    }

    index = end;

    if (match[1]) {
      result += "$";
      continue;
    }

    const key = match[2] || match[3];
    const value = variables.get(key);
    let replacement: string | undefined;

    try {
      replacement = resolveMatch(value, match[4] as Operator, defaultValue);
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

    // Appended to the output and never scanned again, so values are literal
    result += replacement ?? "";
  }

  return result + str.slice(index);
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
