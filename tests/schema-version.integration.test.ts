import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { describe, expect, it } from "vitest";
import { type ComposeSpec, prepareSpec } from "../src/compose.js";
import { normalizeStackSpecification } from "../src/engine.js";
import type { Settings } from "../src/settings.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker stack config --help", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = dockerAvailable() ? describe : describe.skip;

// A file without a `version` is validated against the default schema version,
// so newer fields such as `healthcheck.start_interval` (3.12) must pass the
// real `docker stack config` (issue #183).
suite("default schema version against docker stack config", () => {
  const settings = {
    manageVariables: false,
    variables: new Map<string, string>(),
  } as Settings;

  it("accepts healthcheck.start_interval in a versionless file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-version-"));
    const file = join(dir, "compose.yaml");
    const spec: ComposeSpec = {
      services: {
        main: {
          image: "nginx",
          healthcheck: {
            test: ["CMD", "true"],
            start_period: "30s",
            start_interval: "5s",
          },
        },
      },
    };

    try {
      writeFileSync(file, dump(await prepareSpec(spec, settings)));
      const normalized = await normalizeStackSpecification(
        [file],
        settings,
        true,
      );

      expect(normalized.services.main.healthcheck?.start_interval).toBe("5s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
