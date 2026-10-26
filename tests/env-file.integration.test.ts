import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  interpolateSpec,
  loadComposeSpecs,
  normalizeSpec,
} from "../src/compose.js";
import type { Settings } from "../src/settings.js";

vi.mock("@actions/core");

function dockerAvailable(): boolean {
  try {
    execSync("docker stack config --help", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = dockerAvailable() ? describe : describe.skip;

// The inlined values pass through the real `docker stack config` and the
// action's interpolation, which must leave them as Compose would set them.
suite("env_file against docker stack config", () => {
  it("produces the values Compose would", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "env-file-")));
    const cwd = process.cwd();
    const settings = {
      manageVariables: false,
      keyInterpolation: false,
      variables: new Map([["B", "bee"]]),
    } as unknown as Settings;

    writeFileSync(
      join(dir, "compose.yaml"),
      "services:\n  app:\n    image: nginx\n    env_file: app.env\n" +
        "    environment:\n      E: explicit\n",
    );
    writeFileSync(
      join(dir, "app.env"),
      "export A=$B\nP=p@$$w0rd\nS='$B'\nT=\"$B\\n\"\nE=file\nU=$E\n",
    );
    process.chdir(dir);

    try {
      const prepared = await loadComposeSpecs(["compose.yaml"], settings);
      const spec = interpolateSpec(
        await normalizeSpec(prepared, settings),
        settings,
      );
      const app = spec.services.app as Record<string, unknown>;

      expect(app.env_file).toBeUndefined();
      expect(app.environment).toEqual({
        A: "bee",
        P: "p@$w0rd",
        S: "$B",
        T: "bee\n",
        E: "explicit",
        U: "explicit",
      });
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
