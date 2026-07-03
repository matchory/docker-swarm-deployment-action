import { CORE_SCHEMA, dump, load, mergeTag } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  containsOverrideTag,
  overrideTagDefinitions,
  Tagged,
} from "../src/override-tags.js";

const schema = CORE_SCHEMA.withTags(mergeTag, ...overrideTagDefinitions);

describe("override tag round-trip", () => {
  it("preserves scalar, sequence, and mapping tags through load→dump", () => {
    const yaml = [
      "services:",
      "  web:",
      "    ports: !override",
      '      - "8080:80"',
      "    environment: !reset null",
      "    labels: !override",
      '      com.x: "y"',
      "",
    ].join("\n");

    const doc = load(yaml, { schema }) as {
      services: { web: { ports: unknown; deploy?: unknown } };
    };
    expect(doc.services.web.ports).toBeInstanceOf(Tagged);

    // An unrelated edit elsewhere must not disturb the tags.
    doc.services.web.deploy = { replicas: 2 };
    const out = dump(doc, { schema });

    expect(out).toContain("ports: !override");
    expect(out).toContain("environment: !reset null");
    expect(out).toContain("labels: !override");
  });
});

describe("containsOverrideTag", () => {
  it("detects a Tagged carrier nested in the spec", () => {
    const spec = {
      services: { web: { ports: new Tagged("!override", "sequence", []) } },
    };
    expect(containsOverrideTag(spec)).toBe(true);
  });

  it("returns false for a plain spec", () => {
    expect(containsOverrideTag({ services: { web: { image: "nginx" } } })).toBe(
      false,
    );
  });
});
