import { access, constants, readdir } from "node:fs/promises";
import { dirname, basename, join as joinPath } from "node:path";

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
  paths: readonly string[]
): Promise<string | null> {
  // Group paths by their directory to minimize directory reads
  const pathsByDir = new Map<string, string[]>();
  
  for (const path of paths) {
    const dir = dirname(path);
    
    if (!pathsByDir.has(dir)) {
      pathsByDir.set(dir, []);
    }
    pathsByDir.get(dir)!.push(path);
  }

  // Read each directory once and cache the results
  const filesByDir = new Map<string, Set<string>>();
  
  for (const [dir, _] of pathsByDir) {
    try {
      const files = await readdir(dir);
      filesByDir.set(dir, new Set(files));
    } catch {
      // Directory doesn't exist or isn't readable
      filesByDir.set(dir, new Set());
    }
  }

  // Now check paths in priority order against cached directory contents
  for (const path of paths) {
    const dir = dirname(path);
    const fileName = basename(path);
    const filesInDir = filesByDir.get(dir);
    
    if (filesInDir && filesInDir.has(fileName)) {
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

export function mapToObject<T>(map: Map<string, T>): Record<string, T> {
  const object: Record<string, T> = {};

  for (const [key, value] of map) {
    object[key] = value;
  }

  return object;
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
 * - Required value substitution: `${VARIABLE_NAME:?default}` or `${VARIABLE_NAME?default}`
 *   If the variable is missing, it throws an error with the default value as the message.
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
      throw new Error(`Missing required value: ${defaultValue}`);
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
      throw new Error(`Variable ${key} is required but not defined`);
    }

    str = str.replace(fullMatch, replacement ?? "");
  } while (match);

  // Finally, replace the placeholder back with single dollar signs
  str = str.replace(new RegExp(placeholder, "g"), "$");

  return str;
}
