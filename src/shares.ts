import type { ComposeSpec } from "./compose.js";

/**
 * Reject a volume that names another stack's shared-storage volume.
 *
 * Docker names a stack's own volumes "<stack>_<key>", so only an explicit
 * `name` can reach another stack's share, and a node that already holds that
 * volume mounts it with no credentials. This catches copy-paste and casual
 * reuse; it is not a control against a deployer. Mirrors swarm::stack in
 * matchory/platform.
 */
export function assertOwnShares(spec: ComposeSpec, stack: string): void {
  const volumes = (spec.volumes ?? {}) as Record<string, unknown>;

  for (const [key, definition] of Object.entries(volumes)) {
    const name =
      definition && typeof definition === "object"
        ? (definition as { name?: unknown }).name
        : undefined;

    if (
      typeof name === "string" &&
      /_shared(-v\d+)?$/.test(name) &&
      !name.startsWith(`${stack}_`)
    ) {
      throw new Error(
        `Volume "${key}" names "${name}", another stack's shared storage. ` +
          `A stack may only mount its own share (${stack}_shared).`,
      );
    }
  }
}
