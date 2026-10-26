import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../src/compose.js";
import { inlineEnvFiles, parseEnvFile } from "../src/env-file.js";
import { Tagged } from "../src/override-tags.js";

vi.mock("@actions/core");

function parse(
  content: string,
  lookup: Record<string, string> = {},
  onUndefined?: (name: string) => void,
) {
  const out = new Map<string, string>();
  parseEnvFile(content, out, new Map(Object.entries(lookup)), onUndefined);
  return Object.fromEntries(out);
}

describe("parseEnvFile", () => {
  it("skips comments and blank lines", () => {
    expect(parse("# comment\n\n  # indented\nA=1\n\n")).toEqual({ A: "1" });
  });

  it("strips an export prefix", () => {
    expect(parse("export A=1\nexport  B=2")).toEqual({ A: "1", B: "2" });
  });

  it("accepts the YAML-style separator", () => {
    expect(parse("A: 1")).toEqual({ A: "1" });
  });

  it("trims whitespace around unquoted values", () => {
    expect(parse("A =  x y  \r\nB=")).toEqual({ A: "x y", B: "" });
  });

  it("removes inline comments after unquoted values only", () => {
    expect(parse("A=x # note\nB=x#y\nC='x # y' # note\nD=\"x # y\"")).toEqual({
      A: "x",
      B: "x#y",
      C: "x # y",
      D: "x # y",
    });
  });

  it("keeps single-quoted values literally", () => {
    expect(parse("A='$B \\n ${C}'\nE='it\\'s'", { B: "bee" })).toEqual({
      A: "$B \\n ${C}",
      E: "it's",
    });
  });

  it("expands escapes in double-quoted values", () => {
    expect(
      parse('A="1\\n2\\t3"\nB="say \\"hi\\""\nC="back\\\\slash"\nD="\\0123"'),
    ).toEqual({ A: "1\n2\t3", B: 'say "hi"', C: "back\\slash", D: "S" });
  });

  it("keeps unknown escapes in double-quoted values", () => {
    expect(parse('A="\\x41\\q"')).toEqual({ A: "\\x41\\q" });
  });

  it("reads multi-line quoted values", () => {
    expect(parse("A=\"one\ntwo\"\nB='three\nfour'\nC=5")).toEqual({
      A: "one\ntwo",
      B: "three\nfour",
      C: "5",
    });
  });

  it("interpolates unquoted and double-quoted values", () => {
    expect(
      parse('A=$B\nC="${B}!"\nD=$$\nE=p@$$w0rd\nF="\\$B"', { B: "bee" }),
    ).toEqual({ A: "bee", C: "bee!", D: "$", E: "p@$w0rd", F: "$B" });
  });

  it("sees earlier keys of the file, after the lookup", () => {
    expect(parse("X=1\nY=${X}\nB=local\nC=$B", { B: "bee" })).toEqual({
      X: "1",
      Y: "1",
      B: "local",
      C: "bee",
    });
  });

  it("reports undefined variables", () => {
    const onUndefined = vi.fn();

    expect(parse("A=x${MISSING}y\nB='$ALSO'", {}, onUndefined)).toEqual({
      A: "xy",
      B: "$ALSO",
    });
    expect(onUndefined).toHaveBeenCalledExactlyOnceWith("MISSING");
  });

  it("takes keys without a value from the lookup, or omits them", () => {
    expect(parse("A\nB\nC=3\nD", { A: "a", D: "$d" })).toEqual({
      A: "a",
      C: "3",
      D: "$d",
    });
  });

  it("keeps CRLF line breaks inside quoted values, as Compose does", () => {
    expect(parse('A="one\r\ntwo"\r\nB=3\r\n')).toEqual({
      A: "one\r\ntwo",
      B: "3",
    });
  });

  it("ignores a UTF-8 byte order mark", () => {
    expect(parse("﻿A=1")).toEqual({ A: "1" });
  });

  it("rejects an unterminated quoted value", () => {
    expect(() => parse('A=1\nB="open\n')).toThrowError(
      'line 3: unterminated quoted value "open',
    );
  });

  it("rejects invalid keys", () => {
    expect(() => parse("A B=1")).toThrowError(
      "line 1: key cannot contain a space",
    );
    expect(() => parse("A$=1")).toThrowError(
      'line 1: unexpected character "$" in variable name "A$=1"',
    );
    expect(() => parse("=1")).toThrowError("line 1: key cannot be empty");
  });
});

describe("inlineEnvFiles", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "env-file-")));
    cwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function file(path: string, content: string) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  async function inline(
    specs: Array<ComposeSpec["services"]>,
    variables: Record<string, string> = {},
    baseDirs: string[] = [],
  ) {
    const prepared = specs.map((services, index) => ({
      spec: { services } as ComposeSpec,
      baseDir: baseDirs[index] ?? ".",
    }));

    await inlineEnvFiles(prepared, {
      variables: new Map(Object.entries(variables)),
      keyInterpolation: false,
    });

    return prepared.map(({ spec }) => spec.services);
  }

  it("inlines a single env_file and removes it", async () => {
    file("app.env", "A=1\nB='$B'\nC=\"$B\"");

    await expect(
      inline([{ app: { image: "nginx", env_file: "app.env" } }], { B: "bee" }),
    ).resolves.toEqual([
      { app: { image: "nginx", environment: { A: "1", B: "$$B", C: "bee" } } },
    ]);
  });

  it("escapes dollar signs so the value is not interpolated again", async () => {
    file("app.env", "P=p@$$w0rd\nD=$$\nI");

    await expect(
      inline([{ app: { env_file: ["app.env"] } }], { I: "$HOME" }),
    ).resolves.toEqual([
      { app: { environment: { P: "p@$$w0rd", D: "$$", I: "$$HOME" } } },
    ]);
  });

  it("lets later env files win over earlier ones", async () => {
    file("a.env", "A=a\nB=a");
    file("b.env", "B=b\nC=$B");

    await expect(
      inline([{ app: { env_file: ["a.env", "b.env"] } }]),
    ).resolves.toEqual([{ app: { environment: { A: "a", B: "b", C: "b" } } }]);
  });

  it("lets explicit environment entries win", async () => {
    file("app.env", "A=file\nB=file\nC=$A\nD=$E");

    await expect(
      inline([
        {
          map: {
            env_file: "app.env",
            environment: { A: "explicit", E: "${V}" },
          },
          list: { env_file: "app.env", environment: ["A=explicit", "E"] },
        },
      ]),
    ).resolves.toEqual([
      {
        map: {
          environment: {
            A: "explicit",
            E: "${V}",
            B: "file",
            C: "explicit",
            D: "",
          },
        },
        list: {
          environment: ["A=explicit", "E", "B=file", "C=explicit", "D="],
        },
      },
    ]);
  });

  it("interpolates explicit values used by the env file", async () => {
    file("app.env", "D=$E");

    await expect(
      inline([{ app: { env_file: "app.env", environment: { E: "${V}!" } } }], {
        V: "v",
      }),
    ).resolves.toEqual([{ app: { environment: { E: "${V}!", D: "v!" } } }]);
  });

  it("lets explicit entries of any file win over env files of later ones", async () => {
    file("app.env", "A=file\nB=file");

    await expect(
      inline([
        { app: { image: "nginx", environment: { A: "base" } } },
        { app: { env_file: "app.env" } },
      ]),
    ).resolves.toEqual([
      { app: { image: "nginx", environment: { A: "base" } } },
      { app: { environment: { B: "file" } } },
    ]);
  });

  it("skips a missing optional env file", async () => {
    file("app.env", "A=1");

    await expect(
      inline([
        {
          app: {
            env_file: [
              { path: "missing.env", required: false },
              { path: "app.env" },
            ],
          },
        },
      ]),
    ).resolves.toEqual([{ app: { environment: { A: "1" } } }]);
  });

  it("fails on a missing required env file", async () => {
    await expect(
      inline([
        { app: { env_file: [{ path: "missing.env", required: true }] } },
      ]),
    ).rejects.toThrowError(
      `Service "app": env_file "${join(dir, "missing.env")}" not found`,
    );
  });

  it("names the file and service when an env file is invalid", async () => {
    file("app.env", 'A=1\nB="open');

    await expect(
      inline([{ app: { env_file: "app.env" } }]),
    ).rejects.toThrowError(
      `Service "app": failed to read env_file "${join(dir, "app.env")}": ` +
        "line 2: unterminated quoted value",
    );
  });

  it("interpolates the env_file path", async () => {
    file("prod.env", "A=1");

    await expect(
      inline([{ app: { env_file: "${STAGE}.env" } }], { STAGE: "prod" }),
    ).resolves.toEqual([{ app: { environment: { A: "1" } } }]);
  });

  it("resolves relative paths against the working directory", async () => {
    file("app.env", "A=root");
    file("docker/app.env", "A=docker");

    await expect(
      inline([{ app: { env_file: "app.env" } }], {}, ["docker"]),
    ).resolves.toEqual([{ app: { environment: { A: "root" } } }]);
  });

  it("resolves relative paths against the working directory with merge tags", async () => {
    file("app.env", "A=root");
    file("docker/app.env", "A=docker");

    const [base, override] = await inline(
      [
        { app: { env_file: "app.env" } },
        { app: { deploy: new Tagged("!override", "mapping", new Map()) } },
      ],
      {},
      ["docker", "other"],
    );

    // The values go to the last file that defines the service.
    expect(base).toEqual({ app: {} });
    expect(override.app).toEqual({
      deploy: new Tagged("!override", "mapping", new Map()),
      environment: { A: "root" },
    });
  });

  it("honors merge tags on env_file and environment", async () => {
    file("a.env", "A=a\nB=a");
    file("b.env", "C=b");

    const [, reset, override] = await inline([
      { app: { env_file: "a.env", environment: { E: "base" } } },
      { app: { env_file: new Tagged("!reset", "scalar", "") } },
      {
        app: {
          env_file: new Tagged("!override", "sequence", ["b.env"]),
          environment: new Tagged("!reset", "scalar", ""),
        },
      },
    ]);

    expect(reset).toEqual({ app: {} });
    expect(override.app).toEqual({
      environment: new Tagged("!override", "mapping", new Map([["C", "b"]])),
    });
  });

  it("does not leak values through an environment shared by a YAML alias", async () => {
    file("a.env", "A=a");
    file("b.env", "A=b");
    const shared = { TZ: "UTC" };

    await expect(
      inline([
        {
          one: { env_file: "a.env", environment: shared },
          two: { env_file: "b.env", environment: shared },
        },
      ]),
    ).resolves.toEqual([
      {
        one: { environment: { TZ: "UTC", A: "a" } },
        two: { environment: { TZ: "UTC", A: "b" } },
      },
    ]);
    expect(shared).toEqual({ TZ: "UTC" });
  });

  it("matches explicit keys after key interpolation", async () => {
    file("app.env", "X_A=file\nX_B=file");
    const prepared = [
      {
        spec: {
          services: {
            app: { env_file: "app.env", environment: { "${P}_A": "explicit" } },
          },
        } as ComposeSpec,
        baseDir: ".",
      },
    ];

    await inlineEnvFiles(prepared, {
      variables: new Map([["P", "X"]]),
      keyInterpolation: true,
    });

    expect(prepared[0].spec.services).toEqual({
      app: { environment: { "${P}_A": "explicit", X_B: "file" } },
    });
  });

  it("rejects an env file format it cannot parse", async () => {
    file("app.env", "A=1");

    await expect(
      inline([{ app: { env_file: [{ path: "app.env", format: "raw" }] } }]),
    ).rejects.toThrowError('Service "app": env_file format "raw"');
  });

  it("leaves services without env files untouched", async () => {
    const services = { app: { image: "nginx", environment: ["A=$B"] } };

    await expect(inline([services])).resolves.toEqual([
      { app: { image: "nginx", environment: ["A=$B"] } },
    ]);
  });
});
