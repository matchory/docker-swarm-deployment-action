import * as crypto from "node:crypto";
import { resolve } from "node:path";
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComposeSpec, defineComposeSpec } from "../src/compose.js";
import * as engine from "../src/engine.js";
import { defineSettings } from "../src/settings.js";
import * as utils from "../src/utils.js";
import {
  decodeLabel,
  defineVariable,
  encodeLabel,
  hashLabel,
  hashVariable,
  ignoreLabel,
  nameLabel,
  processVariable,
  pruneConfigs,
  pruneSecrets,
  pruneVariables,
  redactSecretValues,
  removeGeneratedVariableFiles,
  stackLabel,
  type Variable,
  versionLabel,
} from "../src/variables.js";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const unlink = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  unlink,
}));
vi.mock("node:crypto", {
  spy: true,
});
vi.mock("@actions/core");
vi.mock("../src/engine.js");
vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    exists: vi.fn(),
  };
});

describe("Variables", () => {
  const settings = defineSettings({
    envVarPrefix: "APP",
    healthCheckWarnings: false,
    keyInterpolation: false,
    manageVariables: true,
    monitor: false,
    monitorInterval: 5,
    monitorTimeout: 300,
    secretValues: new Map(),
    stack: "test",
    strictCompatibility: false,
    strictVariables: true,
    uploadComposeSpec: false,
    variables: new Map(),
    version: "1.0.0",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    settings.variables = new Map();
  });

  afterEach(removeGeneratedVariableFiles);

  describe("Processing", () => {
    it("should process variables with default values", async () => {
      const variable = defineVariable({
        content: "secret",
      });
      const expectedHash = hashVariable("secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      await expect(processVariable("foo", variable, settings)).resolves.toEqual(
        {
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      );
    });

    it("should process variables with a custom name", async () => {
      const variable = defineVariable({
        name: "bar",
        content: "secret",
      });
      const expectedHash = hashVariable("secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      await expect(processVariable("foo", variable, settings)).resolves.toEqual(
        {
          name: `bar-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      );
    });

    it("should process variables with custom labels", async () => {
      const variable = defineVariable({
        content: "secret",
        labels: {
          "custom-label": "custom-value",
          [hashLabel]: "what are you gonna do about it?",
        },
      });
      const expectedHash = hashVariable("secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );

      await expect(processVariable("foo", variable, settings)).resolves.toEqual(
        {
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            "custom-label": "custom-value",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      );
    });

    it("should not process variables with the ignore label", async () => {
      const variable = defineVariable({
        name: "some-secret",
        file: "./some-file.txt",
        labels: {
          [ignoreLabel]: "true",
        },
      });

      await expect(processVariable("foo", variable, settings)).resolves.toEqual(
        {
          name: "some-secret",
          file: "./some-file.txt",
          labels: { [ignoreLabel]: "true" },
        },
      );
    });

    it.each([
      [{ external: true }],
      [{ external: { name: "shared-db" } }],
      [{ name: "shared-db", external: true }],
    ])("should not process external variables: %j", async (definition) => {
      // A matching environment variable must not turn it into a file source.
      settings.variables.set("db", "secret");

      await expect(
        processVariable("db", defineVariable(definition), settings),
      ).resolves.toEqual(definition);
    });

    it("should treat null variables as empty objects", async () => {
      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      settings.variables.set("foo", "secret");
      await expect(processVariable("foo", null, settings)).resolves.toEqual({
        name: "test-foo-2bb80d5",
        file: resolve(
          "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
        ),
        labels: {
          [nameLabel]: "foo",
          [hashLabel]:
            "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
          [stackLabel]: "test",
          [versionLabel]: "1.0.0",
        },
      });
    });

    it("should infer variables from the environment if strict variables are disabled", async () => {
      const variable = defineVariable({
        file: "./missing.txt",
      });
      const expectedHash = hashVariable("secret");

      vi.spyOn(utils, "exists").mockResolvedValue(false);
      settings.variables.set("FOO", "secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );

      await expect(
        processVariable("foo", variable, {
          ...settings,
          strictVariables: false,
        }),
      ).resolves.toEqual({
        name: `test-foo-${expectedHash.slice(0, 7)}`,
        file: resolve(
          "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
        ),
        labels: {
          [nameLabel]: "foo",
          [hashLabel]: expectedHash,
          [stackLabel]: "test",
          [versionLabel]: "1.0.0",
        },
      });
    });

    it("should give values differing only in whitespace distinct names", async () => {
      const names = await Promise.all(
        ["secret", "secret\n", " secret"].map(
          async (content) =>
            (await processVariable("foo", { content }, settings)).name,
        ),
      );

      expect(new Set(names).size).toBe(3);
    });

    it("should reject variable names that exceed Docker's 64-character limit", async () => {
      const longName = "a".repeat(57); // stack "test" + "-" + 57 + "-" + 7 = 70 > 64
      const variable = defineVariable({ content: "secret" });

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      await expect(
        processVariable(longName, variable, settings),
      ).rejects.toThrow(/exceeds Docker's 64-character limit/);
    });

    it("should accept variable names at exactly the 64-character limit", async () => {
      // final name: "test-" + name + "-" + 7 = 64
      // so name length = 64 - 5 - 8 = 51
      const name = "a".repeat(51);
      const variable = defineVariable({ content: "secret" });

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      const result = await processVariable(name, variable, settings);
      expect(result.name).toHaveLength(64);
    });

    describe("Environment Source", () => {
      it("should process variables with an environment variable source", async () => {
        const variable = defineVariable({
          environment: "FOO_BAR",
        });
        settings.variables.set("FOO_BAR", "secret");
        const expectedHash = hashVariable("secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        await removeGeneratedVariableFiles();
        expect(unlink).toHaveBeenCalledExactlyOnceWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
        );
      });

      it("should not interpolate variables within environment variable content", async () => {
        const variable = defineVariable({
          environment: "CONFIG_TEMPLATE",
        });

        settings.variables.set(
          "CONFIG_TEMPLATE",
          "server=${SERVER_HOST}:${SERVER_PORT:-3000}",
        );
        settings.variables.set("SERVER_HOST", "api.example.com");
        // SERVER_PORT not set, should use default

        const expectedContent = "server=${SERVER_HOST}:${SERVER_PORT:-3000}";
        const expectedHash = hashVariable(expectedContent);

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("server-config", variable, settings),
        ).resolves.toEqual({
          name: `test-server-config-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "server-config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "server-config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          resolve(
            "server-config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          Buffer.from(expectedContent),
          { mode: 0o600 },
        );
      });

      it("should bail on missing environment variables", async () => {
        const variable = defineVariable({
          environment: "FOO_BAR",
        });

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError();
      });
    });

    describe("File Source", () => {
      it("should process variables with a file source", async () => {
        const variable = defineVariable({
          file: "path/to/file",
        });
        const expectedHash = hashVariable("secret");

        readFile.mockResolvedValue(Buffer.from("secret"));
        vi.spyOn(utils, "exists").mockResolvedValue(true);

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve("path/to/file"),
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        await removeGeneratedVariableFiles();
        expect(unlink).not.toHaveBeenCalled();
      });

      it("should hash the file content exactly as it is deployed", async () => {
        const variable = defineVariable({
          file: "path/to/file",
        });
        const expectedHash = hashVariable("secret\n");

        readFile.mockResolvedValue(Buffer.from("secret\n"));
        vi.spyOn(utils, "exists").mockResolvedValue(true);

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve("path/to/file"),
          labels: { [hashLabel]: expectedHash },
        });
      });

      // Decoded as UTF-8, both bytes would become the same replacement
      // character, so the secret would keep its name while its content changed.
      it("should hash the raw bytes of a binary file", async () => {
        const variable = defineVariable({
          file: "path/to/file",
        });

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile
          .mockResolvedValueOnce(Buffer.from([0xff]))
          .mockResolvedValueOnce(Buffer.from([0xfe]));

        const first = await processVariable("foo", variable, settings);
        const second = await processVariable("foo", variable, settings);

        expect(first.labels?.[hashLabel]).toBe(
          hashVariable(Buffer.from([0xff])),
        );
        expect(second.labels?.[hashLabel]).toBe(
          hashVariable(Buffer.from([0xfe])),
        );
      });

      it("should encode the raw bytes of a binary file", async () => {
        const variable = defineVariable({
          file: "path/to/file",
          labels: { [encodeLabel]: "base64" },
        });
        const encoded = Buffer.from([0xff, 0x00]).toString("base64");

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from([0xff, 0x00]));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({
          labels: { [hashLabel]: hashVariable(encoded) },
        });
        expect(writeFile).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          Buffer.from(encoded),
          { mode: 0o600 },
        );
      });

      it("should decode a file to raw bytes", async () => {
        const variable = defineVariable({
          file: "path/to/file",
          labels: { [decodeLabel]: "hex" },
        });

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("ff00"));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({
          labels: { [hashLabel]: hashVariable(Buffer.from([0xff, 0x00])) },
        });
        expect(writeFile).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          Buffer.from([0xff, 0x00]),
          { mode: 0o600 },
        );
      });

      it("should reject a file property that is not a path with a clear error", async () => {
        const variable = { file: null } as unknown as Variable;

        vi.spyOn(utils, "exists").mockResolvedValue(false);

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError(/specifies the file "null"/);
      });

      it("should bail on missing files", async () => {
        const variable = defineVariable({
          file: "path/to/file",
        });

        vi.spyOn(utils, "exists").mockReturnValue(Promise.resolve(false));

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError();
      });

      it("should not throw an error if a variable is explicitly defined empty", async () => {
        const variable = defineVariable({
          file: "path/to/file",
        });

        vi.spyOn(utils, "exists").mockResolvedValueOnce(true);
        readFile.mockResolvedValueOnce(Buffer.from(""));

        await processVariable("foo", variable, settings);
        expect(core.warning).toHaveBeenCalledOnce();
      });
    });

    describe("Content Source", () => {
      it("should process variables with a content source", async () => {
        const variable = defineVariable({
          content: "secret",
        });
        const expectedHash = hashVariable("secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should interpolate variables within content source", async () => {
        const variable = defineVariable({
          content: "client-id=${CLIENT_ID}\nclient-secret=${CLIENT_SECRET}",
        });

        settings.variables.set("CLIENT_ID", "my-client-id");
        settings.variables.set("CLIENT_SECRET", "my-secret");

        const expectedContent =
          "client-id=my-client-id\nclient-secret=my-secret";
        const expectedHash = hashVariable(expectedContent);

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("example-secret", variable, settings),
        ).resolves.toEqual({
          name: `test-example-secret-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "example-secret.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "example-secret",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          resolve(
            "example-secret.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          Buffer.from(expectedContent),
          { mode: 0o600 },
        );
      });

      it("should interpolate variables within content source with default values", async () => {
        const variable = defineVariable({
          content: "url=${BASE_URL:-http://localhost}\nport=${PORT:-8080}",
        });

        settings.variables.set("BASE_URL", "https://example.com");
        // PORT is not set, so should use default

        const expectedContent = "url=https://example.com\nport=8080";
        const expectedHash = hashVariable(expectedContent);

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("config", variable, settings),
        ).resolves.toEqual({
          name: `test-config-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          resolve(
            "config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          Buffer.from(expectedContent),
          { mode: 0o600 },
        );
      });

      it("should warn once per undefined variable within content source", async () => {
        const variable = defineVariable({
          content: "a=${MISSING}\nb=$MISSING\nc=${OPTIONAL:-c}",
        });

        await processVariable("config", variable, settings);

        expect(core.warning).toHaveBeenCalledExactlyOnceWith(
          'The "MISSING" variable used in the content of "config" is not ' +
            "set. Defaulting to a blank string.",
        );
        expect(writeFile).toHaveBeenCalledWith(
          expect.any(String),
          Buffer.from("a=\nb=\nc=c"),
          { mode: 0o600 },
        );
      });

      it("should name the variable whose content has a malformed reference", async () => {
        const variable = defineVariable({ content: "a=${A.b}" });

        await expect(
          processVariable("config", variable, settings),
        ).rejects.toThrow(
          'The content of "config": Invalid interpolation format "${A.b}"',
        );
      });

      it("should not throw an error if a variable is explicitly defined empty", async () => {
        const variable = defineVariable({
          content: "",
        });
        await processVariable("foo", variable, settings);
        expect(core.warning).toHaveBeenCalledOnce();
      });
    });

    describe("Missing Source", () => {
      it("should automatically infer exact-match environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("foo_bAr", "secret");
        settings.variables.set("FOO_BAR", "uppercase");
        settings.variables.set("APP_foo_bAr", "prefixed");
        settings.variables.set("APP_FOO_BAR", "prefixed uppercase");
        settings.variables.set("test_foo_bAr", "stack");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should replace dashes in variable names with underscores in environment variables for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("foo_bar_baz", "secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo-bar-baz", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-bar-baz-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo-bar-baz.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo-bar-baz",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should automatically infer uppercase environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("FOO_BAR", "secret");
        settings.variables.set("APP_foo_bAr", "prefixed");
        settings.variables.set("APP_FOO_BAR", "prefixed uppercase");
        settings.variables.set("test_foo_bAr", "stack");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo-bar", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-bar-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo-bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo-bar",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should automatically infer prefixed environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("APP_foo_bAr", "secret");
        settings.variables.set("APP_FOO_BAR", "prefixed uppercase");
        settings.variables.set("test_foo_bAr", "stack");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");
        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should automatically infer prefixed uppercase environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("APP_FOO_BAR", "secret");
        settings.variables.set("test_foo_bAr", "stack");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");
        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should automatically infer stack-prefixed environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("test_foo_bAr", "secret");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");
        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should automatically infer stack-prefixed environment variable for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("TEST_FOO_BAR", "secret");
        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
      });

      it("should not interpolate variables in inferred environment variables", async () => {
        const variable = defineVariable({});

        settings.variables.set(
          "FOO_CONFIG",
          "database=${DB_HOST:-localhost}:${DB_PORT:-5432}",
        );
        settings.variables.set("DB_HOST", "db.example.com");
        // DB_PORT not set, should use default

        const expectedContent =
          "database=${DB_HOST:-localhost}:${DB_PORT:-5432}";
        const expectedHash = hashVariable(expectedContent);

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_config", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_config-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo_config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [nameLabel]: "foo_config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          resolve(
            "foo_config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          Buffer.from(expectedContent),
          { mode: 0o600 },
        );
      });

      it("should automatically use a secret file for missing sources", async () => {
        const variable = defineVariable({});
        const expectedHash = hashVariable("secret");

        settings.variables.set("foo_bAr", "environment");
        settings.variables.set("FOO_BAR", "uppercase");
        settings.variables.set("APP_foo_bAr", "prefixed");
        settings.variables.set("APP_FOO_BAR", "prefixed uppercase");
        settings.variables.set("test_foo_bAr", "stack");
        settings.variables.set("TEST_FOO_BAR", "stack uppercase");

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("secret"));

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: resolve("foo_bAr.secret"),
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(utils.exists).toHaveBeenCalledWith(resolve("foo_bAr.secret"));
      });

      it("should throw an error if no source is provided and none can be inferred", async () => {
        const variable = defineVariable({});

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError();
      });
    });

    describe("Encoding", () => {
      it("should encode variables as base64", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [encodeLabel]: "base64",
          },
        });
        const expectedHash = hashVariable(
          Buffer.from("secret").toString("base64"),
        );

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: "test-foo-1c1185e",
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [encodeLabel]: "base64",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from(Buffer.from("secret").toString("base64")),
          { mode: 0o600 },
        );
      });

      // Only the encoded file is deployed, so the plaintext value must never be
      // written to disk alongside it.
      it("should write only the encoded file for an environment source", async () => {
        const variable = defineVariable({
          environment: "FOO_BAR",
          labels: {
            [encodeLabel]: "base64",
          },
        });
        settings.variables.set("FOO_BAR", "secret");

        await processVariable("foo", variable, settings);

        expect(writeFile).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          Buffer.from(Buffer.from("secret").toString("base64")),
          { mode: 0o600 },
        );
      });

      it("should write only the encoded file for a content source", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [encodeLabel]: "hex",
          },
        });

        await processVariable("foo", variable, settings);

        expect(writeFile).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          Buffer.from(Buffer.from("secret").toString("hex")),
          { mode: 0o600 },
        );
      });

      it("should encode variables as base64url", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [encodeLabel]: "base64url",
          },
        });
        const expectedHash = hashVariable(
          Buffer.from("secret").toString("base64url"),
        );

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: "test-foo-1c1185e",
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [encodeLabel]: "base64url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from(Buffer.from("secret").toString("base64url")),
          { mode: 0o600 },
        );
      });

      it("should encode variables as hex", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [encodeLabel]: "hex",
          },
        });
        const expectedHash = hashVariable(
          Buffer.from("secret").toString("hex"),
        );

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [encodeLabel]: "hex",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from(Buffer.from("secret").toString("hex")),
          { mode: 0o600 },
        );
      });

      it("should encode variables as a URI component", async () => {
        const variable = defineVariable({
          content: "some[secret]=value",
          labels: {
            [encodeLabel]: "url",
          },
        });
        const expectedHash = hashVariable(
          encodeURIComponent("some[secret]=value"),
        );

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [encodeLabel]: "url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from(encodeURIComponent("some[secret]=value")),
          { mode: 0o600 },
        );
      });

      it("should bail on unknown encoding", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [encodeLabel]: "unknown",
          },
        });

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError();
      });
    });

    describe("Decoding", () => {
      it("should decode variables from base64", async () => {
        const variable = defineVariable({
          content: Buffer.from("secret").toString("base64"),
          labels: {
            [decodeLabel]: "base64",
          },
        });
        const expectedHash = hashVariable("secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [decodeLabel]: "base64",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from("secret"),
          { mode: 0o600 },
        );
      });

      it("should decode variables from base64url", async () => {
        const variable = defineVariable({
          content: Buffer.from("secret").toString("base64url"),
          labels: {
            [decodeLabel]: "base64url",
          },
        });
        const expectedHash = hashVariable("secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [decodeLabel]: "base64url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from("secret"),
          { mode: 0o600 },
        );
      });

      it("should decode variables from hex", async () => {
        const variable = defineVariable({
          content: Buffer.from("secret").toString("hex"),
          labels: {
            [decodeLabel]: "hex",
          },
        });
        const expectedHash = hashVariable("secret");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [decodeLabel]: "hex",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from("secret"),
          { mode: 0o600 },
        );
      });

      it("should decode variables from a URI component", async () => {
        const variable = defineVariable({
          content: encodeURIComponent("some[secret]=value"),
          labels: {
            [decodeLabel]: "url",
          },
        });
        const expectedHash = hashVariable("some[secret]=value");

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: resolve(
            "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          ),
          labels: {
            [decodeLabel]: "url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
          Buffer.from("some[secret]=value"),
          { mode: 0o600 },
        );
      });

      it("should bail on unknown encoding", async () => {
        const variable = defineVariable({
          content: "secret",
          labels: {
            [decodeLabel]: "unknown",
          },
        });

        await expect(
          processVariable("foo", variable, settings),
        ).rejects.toThrowError();
      });

      it("should decode binary content without altering its bytes", async () => {
        const variable = defineVariable({
          content: Buffer.from([0xff, 0x00]).toString("base64"),
          labels: {
            [decodeLabel]: "base64",
          },
        });

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({
          labels: { [hashLabel]: hashVariable(Buffer.from([0xff, 0x00])) },
        });
        expect(writeFile).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          Buffer.from([0xff, 0x00]),
          { mode: 0o600 },
        );
      });
    });

    // File paths pass through spec interpolation after processing, so a `$` in
    // the working directory must be stored escaped to reach Docker intact.
    describe("Working Directory With a Dollar Sign", () => {
      const cwd = "/work/repo$x";
      const escaped = "/work/repo$$x";

      beforeEach(() => {
        vi.spyOn(process, "cwd").mockReturnValue(cwd);
        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );
      });

      afterEach(() => {
        vi.mocked(process.cwd).mockRestore();
      });

      it("should escape the path of a generated file", async () => {
        const variable = defineVariable({ environment: "FOO_BAR" });
        const generated =
          "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret";
        settings.variables.set("FOO_BAR", "secret");

        const { file } = (await processVariable("foo", variable, settings)) as {
          file: string;
        };

        expect(file).toBe(`${escaped}/${generated}`);
        expect(utils.interpolateString(file, new Map())).toBe(
          `${cwd}/${generated}`,
        );
        expect(writeFile).toHaveBeenCalledWith(
          `${cwd}/${generated}`,
          expect.any(Buffer),
          { mode: 0o600 },
        );

        await removeGeneratedVariableFiles();
        expect(unlink).toHaveBeenCalledExactlyOnceWith(`${cwd}/${generated}`);
      });

      it("should read and deploy the same file for a file source", async () => {
        const variable = defineVariable({ file: "path/$${A}/file" });

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("secret"));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({ file: `${escaped}/path/$\${A}/file` });
        expect(readFile).toHaveBeenCalledWith(`${cwd}/path/\${A}/file`);
      });

      it("should interpolate variables in the path of a file source", async () => {
        const variable = defineVariable({ file: "${DIR}/file" });
        settings.variables.set("DIR", "secrets");

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("secret"));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({ file: `${escaped}/secrets/file` });
        expect(readFile).toHaveBeenCalledWith(`${cwd}/secrets/file`);
      });

      it("should leave an absolute file source unchanged", async () => {
        const variable = defineVariable({ file: "/run/$$secrets/file" });

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("secret"));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({ file: "/run/$$secrets/file" });
      });

      it("should escape the path of an inferred secret file", async () => {
        const variable = defineVariable({});

        vi.spyOn(utils, "exists").mockResolvedValue(true);
        readFile.mockResolvedValue(Buffer.from("secret"));

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toMatchObject({ file: `${escaped}/foo.secret` });
        expect(utils.exists).toHaveBeenCalledWith(`${cwd}/foo.secret`);
      });
    });
  });

  describe("Cleanup", () => {
    it("should remove files when writing their content fails", async () => {
      const variable = defineVariable({ environment: "FOO_BAR" });
      settings.variables.set("FOO_BAR", "secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      writeFile.mockRejectedValue(new Error("Write failed"));
      unlink.mockRejectedValue(
        Object.assign(new Error("File not found"), { code: "ENOENT" }),
      );

      await expect(
        processVariable("foo", variable, settings),
      ).rejects.toThrowError("Write failed");
      await removeGeneratedVariableFiles();

      expect(unlink).toHaveBeenCalledWith(
        resolve("foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret"),
      );
    });

    it("should warn but not throw when a file cannot be removed", async () => {
      const variable = defineVariable({ environment: "FOO_BAR" });
      settings.variables.set("FOO_BAR", "secret");

      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      unlink.mockRejectedValueOnce(new Error("Permission denied"));

      await processVariable("foo", variable, settings);

      await expect(removeGeneratedVariableFiles()).resolves.not.toThrow();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Permission denied"),
      );
    });
  });

  describe("Pruning", () => {
    it("should prune configs, keeping the newest previous version", async () => {
      const spec = defineComposeSpec({
        services: {},
        configs: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-7d865e9",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "3",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-b5bb9d8",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);

      await pruneConfigs(spec, settings);

      expect(engine.listConfigs).toHaveBeenCalledOnce();
      expect(engine.removeConfig).toHaveBeenCalledTimes(1);
      expect(engine.removeConfig).toHaveBeenCalledWith("1");
    });

    it("should prune secrets, keeping the newest previous version", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-7d865e9",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "3",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-b5bb9d8",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);

      await pruneSecrets(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.removeSecret).toHaveBeenCalledTimes(1);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
    });

    it("should keep only the newest previous version of variables in the spec", async () => {
      const labels = (name: string, hash: string) => ({
        [nameLabel]: name,
        [hashLabel]: hash.padEnd(64, "0"),
        [stackLabel]: "test",
        [versionLabel]: "1.0.0",
      });
      const secret = (
        id: string,
        createdAt: string,
        name: string,
        hash: string,
      ) => ({
        ID: id,
        CreatedAt: createdAt,
        UpdatedAt: createdAt,
        Name: `test-${name}-${hash}`,
        Labels: labels(name, hash),
      });
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-ccc",
            file: "./foo.generated.secret",
            labels: labels("foo", "ccc"),
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        secret("1", "2026-03-01T00:00:00Z", "foo", "aaa"),
        secret("2", "2026-04-01T00:00:00Z", "foo", "bbb"),
        secret("3", "2026-05-01T00:00:00Z", "foo", "ccc"),
        secret("4", "2026-02-01T00:00:00Z", "foo", "ddd"),
        secret("5", "2026-04-01T00:00:00Z", "retired", "aaa"),
        secret("6", "2026-03-01T00:00:00Z", "retired", "bbb"),
      ]);

      await pruneSecrets(spec, settings);

      expect(engine.removeSecret).toHaveBeenCalledTimes(4);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeSecret).toHaveBeenCalledWith("4");
      expect(engine.removeSecret).toHaveBeenCalledWith("5");
      expect(engine.removeSecret).toHaveBeenCalledWith("6");
    });

    it("should issue a warning for secrets that have not been rotated for a long time", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: "2023-10-01T00:00:00Z",
          UpdatedAt: "2023-10-01T00:00:00Z",
          Name: "test-foo-7d865e9",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);
      vi.spyOn(core, "warning").mockImplementationOnce(() => {});

      await pruneSecrets(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.removeSecret).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledOnce();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Secret "test-foo-7d865e9"'),
      );
    });

    it("should not issue rotation warnings for outdated secrets", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: "./foo.generated.secret",
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: "2023-10-01T00:00:00Z",
          UpdatedAt: "2023-10-01T00:00:00Z",
          Name: "test-foo-7d865e9",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);
      vi.spyOn(core, "warning").mockImplementation(() => {});

      await pruneSecrets(spec, settings);

      expect(core.warning).not.toHaveBeenCalled();
    });

    it("should not prune outdated versions on an unrelated variable", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          bar: {
            name: "test-bar-b5bb9d8",
            file: resolve(
              "bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "bar",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
          other_bar: {
            name: "test-other_bar-bf07a7f",
            file: resolve(
              "other_bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "other_bar",
              [hashLabel]:
                "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
        configs: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
          other_foo: {
            name: "test-other_foo-bf07a7f",
            file: resolve(
              "other_foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "other_foo",
              [hashLabel]:
                "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });

      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-bar-bf07a7f",
          Labels: {
            [nameLabel]: "bar",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-other_bar-bf07a7f",
          Labels: {
            [nameLabel]: "other_bar",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "3",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-bar-b5bb9d8",
          Labels: {
            [nameLabel]: "bar",
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "4",
          CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-bar-7d865e9",
          Labels: {
            [nameLabel]: "bar",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-other_foo-bf07a7f",
          Labels: {
            [nameLabel]: "other_foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "3",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-b5bb9d8",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "4",
          CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-7d865e9",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
      expect(engine.removeSecret).toHaveBeenCalledTimes(1);
      expect(engine.removeConfig).toHaveBeenCalledTimes(1);
      expect(engine.removeSecret).toHaveBeenCalledWith("4");
      expect(engine.removeConfig).toHaveBeenCalledWith("4");
    });

    it("should still prune if no secrets or configs are present in the spec", async () => {
      const spec = defineComposeSpec({
        services: {},
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
      expect(engine.removeSecret).toHaveBeenCalledTimes(1);
      expect(engine.removeConfig).toHaveBeenCalledTimes(1);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeConfig).toHaveBeenCalledWith("1");
    });

    it("should do nothing if there are no secrets or configs defined in the cluster", async () => {
      const spec = defineComposeSpec({
        services: {},
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([]);
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
    });

    it("should do nothing if there are secrets or configs present in the spec, but none defined in the cluster", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          bar: {
            name: "test-bar-b5bb9d8",
            file: resolve(
              "bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "bar",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
        configs: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
            labels: {
              [nameLabel]: "foo",
              [hashLabel]:
                "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
              [stackLabel]: "test",
              [versionLabel]: "1.0.0",
            },
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([]);
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
    });

    it("should prune secrets and configs with some missing control labels", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: resolve(
              "foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
          },
        },
        configs: {
          bar: {
            name: "test-bar-b5bb9d8",
            file: resolve(
              "bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
            ),
          },
        },
      });
      vi.spyOn(engine, "listSecrets").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-bar-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-bar-b5bb9d8",
          Labels: {
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
      ]);
      vi.spyOn(engine, "listConfigs").mockResolvedValueOnce([
        {
          ID: "1",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Name: "test-foo-bf07a7f",
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "bf07a7fbb825fc0aae7bf4a1177b2b31fcf8a3feeaf7092761e18c859ee52a9c",
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        },
        {
          ID: "2",
          Name: "test-foo-b5bb9d8",
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
          Labels: {
            [nameLabel]: "foo",
            [hashLabel]:
              "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
            [versionLabel]: "1.0.0",
          },
        },
      ]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
      expect(engine.removeSecret).toHaveBeenCalledTimes(2);
      expect(engine.removeConfig).toHaveBeenCalledTimes(2);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeSecret).toHaveBeenCalledWith("2");
      expect(engine.removeConfig).toHaveBeenCalledWith("1");
      expect(engine.removeConfig).toHaveBeenCalledWith("2");
    });
  });

  describe("redactSecretValues", () => {
    const spec = (services: ComposeSpec["services"]) =>
      defineComposeSpec({ version: "3.8", services });

    it("should replace a whole-string secret value with its variable name", () => {
      const result = redactSecretValues(
        spec({ app: { environment: { TOKEN: "s3cr3t-value-here" } } }),
        new Map([["TOKEN", "s3cr3t-value-here"]]),
      );

      expect(result.services).toEqual({
        app: { environment: { TOKEN: "${TOKEN}" } },
      });
    });

    it("should replace a secret embedded in a longer string", () => {
      const result = redactSecretValues(
        spec({
          app: {
            environment: {
              DATABASE_URL: "postgres://user:sup3rs3cr3tpw@host/db",
            },
          },
        }),
        new Map([["PASSWORD", "sup3rs3cr3tpw"]]),
      );

      expect(result.services).toEqual({
        app: {
          environment: {
            DATABASE_URL: "postgres://user:${PASSWORD}@host/db",
          },
        },
      });
    });

    // Substring-redacting a short value would corrupt unrelated strings: a
    // secret of "1" would rewrite every "1" in the spec, image tags included.
    it("should not substring-redact a short secret value", () => {
      const result = redactSecretValues(
        spec({ app: { image: "nginx:1.27" } }),
        new Map([["REPLICAS", "1"]]),
      );

      expect(result.services).toEqual({ app: { image: "nginx:1.27" } });
    });

    it("should still redact a short secret that is an entire value", () => {
      const result = redactSecretValues(
        spec({ app: { environment: { PIN: "1234" } } }),
        new Map([["PIN", "1234"]]),
      );

      expect(result.services).toEqual({
        app: { environment: { PIN: "${PIN}" } },
      });
    });

    it("should leave values that did not come from the secrets input alone", () => {
      const result = redactSecretValues(
        spec({ app: { environment: { REGION: "eu-central-1" } } }),
        new Map([["TOKEN", "unrelated-secret-value"]]),
      );

      expect(result.services).toEqual({
        app: { environment: { REGION: "eu-central-1" } },
      });
    });

    it("should not mutate the spec it was given", () => {
      const original = spec({
        app: { environment: { TOKEN: "s3cr3t-value-here" } },
      });

      redactSecretValues(original, new Map([["TOKEN", "s3cr3t-value-here"]]));

      expect(original.services).toEqual({
        app: { environment: { TOKEN: "s3cr3t-value-here" } },
      });
    });

    // A file path holds no secret value, but often contains a string that
    // happens to equal one, such as the repository name in the workspace path.
    it("should not redact the file paths of secrets and configs", () => {
      const file = "/home/runner/work/acme-backend/acme-backend/db.secret";
      const result = redactSecretValues(
        defineComposeSpec({
          version: "3.8",
          services: {
            app: { environment: { REPOSITORY: "acme-backend" } },
          },
          secrets: { db: { name: "acme-backend-db", file } },
          configs: { app: { file } },
        }),
        new Map([["REPOSITORY", "acme-backend"]]),
      );

      expect(result.services).toEqual({
        app: { environment: { REPOSITORY: "${REPOSITORY}" } },
      });
      expect(result.secrets).toEqual({
        db: { name: "${REPOSITORY}-db", file },
      });
      expect(result.configs).toEqual({ app: { file } });
    });

    it("should ignore empty secret values", () => {
      const result = redactSecretValues(
        spec({ app: { image: "nginx:latest" } }),
        new Map([["EMPTY", ""]]),
      );

      expect(result.services).toEqual({ app: { image: "nginx:latest" } });
    });
  });
});
