import * as core from "@actions/core";
import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComposeSpec } from "../src/compose.js";
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
  stackLabel,
  versionLabel,
} from "../src/variables.js";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
}));
vi.mock("node:crypto", {
  spy: true,
});
vi.mock("@actions/core");
vi.mock("../src/engine.js");
vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exists: vi.fn(),
  };
});

describe("Variables", () => {
  const settings = defineSettings({
    envVarPrefix: "APP",
    keyInterpolation: false,
    manageVariables: true,
    monitor: false,
    monitorInterval: 5,
    monitorTimeout: 300,
    stack: "test",
    strictVariables: true,
    variables: new Map(),
    version: "1.0.0",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    settings.variables = new Map();
  });

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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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

    it("should treat null variables as empty objects", async () => {
      vi.spyOn(crypto, "randomUUID").mockImplementation(
        () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
      );
      settings.variables.set("foo", "secret");
      await expect(processVariable("foo", null, settings)).resolves.toEqual({
        name: "test-foo-2bb80d5",
        file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
        file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
        labels: {
          [nameLabel]: "foo",
          [hashLabel]: expectedHash,
          [stackLabel]: "test",
          [versionLabel]: "1.0.0",
        },
      });
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
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
          file: "./server-config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [nameLabel]: "server-config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          "./server-config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          expectedContent,
          "utf8",
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

        readFile.mockResolvedValue("secret");
        vi.spyOn(utils, "exists").mockResolvedValue(true);

        await expect(
          processVariable("foo", variable, settings),
        ).resolves.toEqual({
          name: `test-foo-${expectedHash.slice(0, 7)}`,
          file: "path/to/file",
          labels: {
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
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
        readFile.mockResolvedValueOnce("");

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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./example-secret.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [nameLabel]: "example-secret",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          "./example-secret.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          expectedContent,
          "utf8",
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
          file: "./config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [nameLabel]: "config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          "./config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          expectedContent,
          "utf8",
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
          file: "./foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo-bar-baz.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo-bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
          file: "./foo_bAr.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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

        const expectedContent = "database=${DB_HOST:-localhost}:${DB_PORT:-5432}";
        const expectedHash = hashVariable(expectedContent);

        vi.spyOn(crypto, "randomUUID").mockImplementation(
          () => "36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34",
        );

        await expect(
          processVariable("foo_config", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_config-${expectedHash.slice(0, 7)}`,
          file: "./foo_config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [nameLabel]: "foo_config",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          "./foo_config.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          expectedContent,
          "utf8",
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
        readFile.mockResolvedValue("secret");

        await expect(
          processVariable("foo_bAr", variable, settings),
        ).resolves.toEqual({
          name: `test-foo_bAr-${expectedHash.slice(0, 7)}`,
          file: "./foo_bAr.secret",
          labels: {
            [nameLabel]: "foo_bAr",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(utils.exists).toHaveBeenCalledWith("./foo_bAr.secret");
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [encodeLabel]: "base64",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          Buffer.from("secret").toString("base64"),
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [encodeLabel]: "base64url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          Buffer.from("secret").toString("base64url"),
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [encodeLabel]: "hex",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });

        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          Buffer.from("secret").toString("hex"),
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [encodeLabel]: "url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          encodeURIComponent("some[secret]=value"),
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [decodeLabel]: "base64",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          "secret",
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [decodeLabel]: "base64url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          "secret",
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [decodeLabel]: "hex",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          "secret",
          "utf8",
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
          file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          labels: {
            [decodeLabel]: "url",
            [nameLabel]: "foo",
            [hashLabel]: expectedHash,
            [stackLabel]: "test",
            [versionLabel]: "1.0.0",
          },
        });
        expect(writeFile).toHaveBeenCalledWith(
          "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          "some[secret]=value",
          "utf8",
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
    });
  });

  describe("Pruning", () => {
    it("should prune configs", async () => {
      const spec = defineComposeSpec({
        services: {},
        configs: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
      expect(engine.removeConfig).toHaveBeenCalledTimes(2);
      expect(engine.removeConfig).toHaveBeenCalledWith("1");
      expect(engine.removeConfig).toHaveBeenCalledWith("2");
    });

    it("should prune secrets", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
      expect(engine.removeSecret).toHaveBeenCalledTimes(2);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeSecret).toHaveBeenCalledWith("2");
    });

    it("should issue a warning for secrets that have not been rotated for a long time", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          foo: {
            name: "test-foo-b5bb9d8",
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
      expect(engine.removeSecret).toHaveBeenCalledTimes(2);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeSecret).toHaveBeenCalledWith("2");
      expect(core.warning).toHaveBeenCalledOnce();
    });

    it("should not prune outdated versions on an unrelated variable", async () => {
      const spec = defineComposeSpec({
        services: {},
        secrets: {
          bar: {
            name: "test-bar-b5bb9d8",
            file: "./bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
            file: "./other_bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
            file: "./other_foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
      ]);

      await pruneVariables(spec, settings);

      expect(engine.listSecrets).toHaveBeenCalledOnce();
      expect(engine.listConfigs).toHaveBeenCalledOnce();
      expect(engine.removeSecret).toHaveBeenCalledTimes(1);
      expect(engine.removeConfig).toHaveBeenCalledTimes(1);
      expect(engine.removeSecret).toHaveBeenCalledWith("1");
      expect(engine.removeConfig).toHaveBeenCalledWith("1");
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
            file: "./bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
            file: "./foo.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
          },
        },
        configs: {
          bar: {
            name: "test-bar-b5bb9d8",
            file: "./bar.36934723-0a0b-4eb6-ab9d-d3a4e5e3cb34.generated.secret",
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
});
