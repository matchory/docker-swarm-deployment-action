import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  type ComposeSpec,
  composeSchema,
  interpolateTypedFields,
  normalizeSpec,
} from "../src/compose.js";
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

// `docker stack config --skip-interpolation` validates the schema while
// variable references are still strings, so typed fields must already hold
// their final type when the real CLI sees them (issue #207).
suite("typed fields against docker stack config", () => {
  const settings = { variables: new Map<string, string>() };

  async function normalize(spec: ComposeSpec) {
    const dir = mkdtempSync(join(tmpdir(), "typed-fields-"));
    const file = join(dir, "compose.yaml");

    try {
      writeFileSync(file, dump(spec));
      return await normalizeStackSpecification([file], settings, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts a variable in a typed field once interpolated and cast", async () => {
    const spec: ComposeSpec = {
      services: {
        main: {
          image: "nginx",
          deploy: { replicas: "${MAIN_REPLICAS:-1}" },
        },
      },
    };

    const normalized = await normalize(interpolateTypedFields(spec, settings));

    expect(normalized.services.main).toHaveProperty("deploy.replicas", 1);
  });

  // A merge-tagged scalar keeps its source text, so the cast must reach inside
  // the tag for the tag-aware merge to hand Docker a number.
  it("casts a merge-tagged typed field and still honors the tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "typed-fields-"));
    const variables = new Map([["REPLICAS", "3"]]);
    const parse = (source: string) =>
      interpolateTypedFields(
        load(source, { schema: composeSchema }) as ComposeSpec,
        { variables },
      );

    try {
      const normalized = await normalizeSpec(
        [
          {
            spec: parse(
              "services:\n  main:\n    image: nginx\n    deploy:\n" +
                "      replicas: 1\n    ports: ['8080:80']\n",
            ),
            baseDir: dir,
          },
          {
            spec: parse(
              "services:\n  main:\n    deploy:\n" +
                "      replicas: !override ${REPLICAS}\n    ports: !reset []\n",
            ),
            baseDir: dir,
          },
        ],
        { variables, strictCompatibility: false } as Settings,
      );

      expect(normalized.services.main).toHaveProperty("deploy.replicas", 3);
      expect(normalized.services.main).not.toHaveProperty("ports");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
