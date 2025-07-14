import { access, constants } from "node:fs/promises";

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
