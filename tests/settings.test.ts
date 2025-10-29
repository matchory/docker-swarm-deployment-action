import { env } from "node:process";
import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../src/settings.js";

vi.mock("@actions/core", { spy: true });

describe("settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("should parse settings with default values", () => {
    vi.stubEnv("GITHUB_REPOSITORY", undefined);
    vi.stubEnv("GITHUB_REF", undefined);
    vi.stubEnv("GITHUB_SHA", undefined);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("unknown");
    expect(settings.version).toBe("unknown");
    expect(settings.composeFiles).toEqual([]);
    expect(settings.envVarPrefix).toBe("DEPLOYMENT");
    expect(settings.keyInterpolation).toBe(false);
    expect(settings.variables).toBeInstanceOf(Map);
    expect(settings.manageVariables).toBe(true);
    expect(settings.strictVariables).toBe(false);
    expect(settings.monitor).toBe(false);
    expect(settings.monitorTimeout).toBe(300);
    expect(settings.monitorInterval).toBe(5);
  });

  it("should parse settings with provided inputs", () => {
    vi.spyOn(core, "getInput").mockImplementation(
      (name) =>
        ({
          "stack-name": "custom-stack",
          version: "1.0.0",
          "compose-file": "file1.yml:file2.yml",
          variables: "VAR1=value1\nVAR2=value2",
          "env-var-prefix": "CUSTOM_PREFIX",
          "monitor-timeout": "600",
          "monitor-interval": "10",
        })[name] || "",
    );
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("custom-stack");
    expect(settings.version).toBe("1.0.0");
    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
    expect(settings.envVarPrefix).toBe("CUSTOM_PREFIX");
    expect(settings.variables).toSatisfy((variables: Map<string, string>) => {
      return (
        variables.get("VAR1") === "value1" && variables.get("VAR2") === "value2"
      );
    });
    expect(settings.monitor).toBe(false);
    expect(settings.monitorTimeout).toBe(600);
    expect(settings.monitorInterval).toBe(10);
  });

  it("should infer version from GITHUB_REF", () => {
    vi.stubEnv("GITHUB_REF", "refs/tags/v1.2.3");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.version).toBe("v1.2.3");
  });

  it("should infer version from GITHUB_SHA if no GITHUB_REF is specified", () => {
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.version).toBe("4fadb58");
  });

  it("should infer stack name from GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "user/repo");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("repo");
  });

  it("should handle missing GITHUB_REPOSITORY gracefully", () => {
    vi.stubEnv("GITHUB_REPOSITORY", undefined);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.stack).toBe("unknown");
  });

  it("should retrieve compose files from COMPOSE_FILE environment variable", () => {
    vi.stubEnv("COMPOSE_FILE", "file1.yml,file2.yml");
    vi.stubEnv("COMPOSE_PATH_SEPARATOR", ",");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.composeFiles).toEqual(["file1.yml", "file2.yml"]);
  });

  it("should parse variables from input", () => {
    vi.stubEnv("INPUT_VARIABLES", "VAR1=value1\nVAR2=value2");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.get("VAR1")).toBe("value1");
    expect(settings.variables.get("VAR2")).toBe("value2");
  });

  it("should handle empty variables input", () => {
    vi.stubEnv("INPUT_VARIABLES", "");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.size).toBeGreaterThanOrEqual(0);
  });

  it("should override environment variables with input variables", () => {
    vi.stubEnv("VAR1", "envValue1");
    vi.stubEnv("VAR2", "envValue2");
    vi.stubEnv("INPUT_VARIABLES", "VAR1=inputValue1\nVAR3=inputValue3");
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(true);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);
    vi.spyOn(core, "getBooleanInput").mockReturnValueOnce(false);

    const settings = parseSettings(env);

    expect(settings.variables.get("VAR1")).toBe("inputValue1");
    expect(settings.variables.get("VAR2")).toBe("envValue2");
    expect(settings.variables.get("VAR3")).toBe("inputValue3");
  });

  describe("edge cases and environment variable handling", () => {
    it("should skip VARIABLES key in environment", () => {
      vi.stubEnv("VARIABLES", "should-skip");
      vi.stubEnv("FOO", "bar");
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);
      const settings = parseSettings(process.env);
      expect(settings.variables.has("VARIABLES")).toBe(false);
      expect(settings.variables.get("FOO")).toBe("bar");
    });

    it("should handle empty input gracefully", () => {
      vi.unstubAllEnvs();
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);
      const settings = parseSettings(process.env);
      expect(settings.variables.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("MATCHORY deployment variables", () => {
    it("should include MATCHORY_DEPLOYMENT_STACK and MATCHORY_DEPLOYMENT_VERSION in variables", () => {
      vi.stubEnv("GITHUB_REPOSITORY", "owner/test-repo");
      vi.stubEnv("GITHUB_SHA", "abc123def456");
      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            "stack-name": "my-custom-stack",
            version: "1.2.3",
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.stack).toBe("my-custom-stack");
      expect(settings.version).toBe("1.2.3");
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_STACK")).toBe(
        "my-custom-stack",
      );
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_VERSION")).toBe(
        "1.2.3",
      );
    });

    it("should include inferred values for MATCHORY_DEPLOYMENT variables", () => {
      vi.stubEnv("GITHUB_REPOSITORY", "owner/inferred-repo");
      vi.stubEnv("GITHUB_REF", "refs/tags/v2.0.0");
      vi.spyOn(core, "getInput").mockReturnValue("");
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.stack).toBe("inferred-repo");
      expect(settings.version).toBe("v2.0.0");
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_STACK")).toBe(
        "inferred-repo",
      );
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_VERSION")).toBe(
        "v2.0.0",
      );
    });
  });

  describe("Multi-line variable parsing", () => {
    it("should parse multi-line variables with HEREDOC syntax", () => {
      const variablesInput = `SOME_VARIABLE<<EOF
foo
bar
EOF
UNRELATED_SINGLE_LINE_VARIABLE=test`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("SOME_VARIABLE")).toBe("foo\nbar");
      expect(settings.variables.get("UNRELATED_SINGLE_LINE_VARIABLE")).toBe(
        "test",
      );
    });

    it("should handle multi-line variables with different delimiters", () => {
      const variablesInput = `CONFIG<<DELIMITER
line1
line2
line3
DELIMITER
SIMPLE_VAR=simple_value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("CONFIG")).toBe("line1\nline2\nline3");
      expect(settings.variables.get("SIMPLE_VAR")).toBe("simple_value");
    });

    it("should handle empty multi-line variables", () => {
      const variablesInput = `EMPTY_VAR<<EOF
EOF
NON_EMPTY=value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("EMPTY_VAR")).toBe("");
      expect(settings.variables.get("NON_EMPTY")).toBe("value");
    });

    it("should handle multi-line variables with leading/trailing whitespace", () => {
      const variablesInput = `SCRIPT<<EOF
  #!/bin/bash
  echo "hello world"  
  exit 0
EOF`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("SCRIPT")).toBe(
        '  #!/bin/bash\n  echo "hello world"  \n  exit 0',
      );
    });

    it("should handle multiple multi-line variables", () => {
      const variablesInput = `FIRST<<EOF
content1
content2
EOF
SECOND<<DELIM
other content
more content
DELIM
REGULAR=simple`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("FIRST")).toBe("content1\ncontent2");
      expect(settings.variables.get("SECOND")).toBe(
        "other content\nmore content",
      );
      expect(settings.variables.get("REGULAR")).toBe("simple");
    });

    it("should maintain backward compatibility with traditional key=value pairs", () => {
      const variablesInput = `VAR1=value1
VAR2=value2
VAR3=value with spaces`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR1")).toBe("value1");
      expect(settings.variables.get("VAR2")).toBe("value2");
      expect(settings.variables.get("VAR3")).toBe("value with spaces");
    });

    it("should ignore comments within multi-line variables", () => {
      const variablesInput = `CONFIG<<EOF
# This is a comment in the config
server=localhost
port=8080
EOF`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("CONFIG")).toBe(
        "# This is a comment in the config\nserver=localhost\nport=8080",
      );
    });

    it("should handle delimiter that appears within content", () => {
      const variablesInput = `CONTENT<<END
This content has the word END in it
but not as a delimiter
END`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("CONTENT")).toBe(
        "This content has the word END in it\nbut not as a delimiter",
      );
    });

    it("should handle HEREDOC without closing delimiter gracefully", () => {
      const variablesInput = `INCOMPLETE<<EOF
some content
without closing delimiter
REGULAR_VAR=value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // Should handle unclosed HEREDOC by including all remaining content
      expect(settings.variables.get("INCOMPLETE")).toBe(
        "some content\nwithout closing delimiter\nREGULAR_VAR=value",
      );
    });

    it("should handle variables with numbers and special characters in names", () => {
      const variablesInput = `VAR_123<<EOF
multi-line content
EOF
CONFIG_V2=simple_value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR_123")).toBe("multi-line content");
      expect(settings.variables.get("CONFIG_V2")).toBe("simple_value");
    });

    it("should handle complex mixed format", () => {
      const variablesInput = `# This is a comment
FIRST_VAR=simple value

# Another comment
MULTI_LINE_CONFIG<<HEREDOC
server {
    listen 80;
    server_name example.com;
    location / {
        return 200 'Hello World';
    }
}
HEREDOC

ANOTHER_VAR=another simple value

SCRIPT<<SCRIPT_END
#!/bin/bash
echo "Starting application..."
cd /app && npm start
SCRIPT_END`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("FIRST_VAR")).toBe("simple value");
      expect(settings.variables.get("MULTI_LINE_CONFIG")).toBe(`server {
    listen 80;
    server_name example.com;
    location / {
        return 200 'Hello World';
    }
}`);
      expect(settings.variables.get("ANOTHER_VAR")).toBe(
        "another simple value",
      );
      expect(settings.variables.get("SCRIPT")).toBe(`#!/bin/bash
echo "Starting application..."
cd /app && npm start`);
    });

    it("should handle invalid delimiter patterns as regular key=value pairs", () => {
      const variablesInput = `INVALID_DELIMITER<<WITH SPACE
should not be treated as heredoc
WITH SPACE
ANOTHER_INVALID<<with-dashes
also should not work
with-dashes
VALID_DELIMITER<<EOF
this should work
EOF
REGULAR=value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // These should not be parsed since they don't match valid patterns
      expect(settings.variables.has("INVALID_DELIMITER")).toBe(false);
      expect(settings.variables.has("ANOTHER_INVALID")).toBe(false);
      expect(settings.variables.get("VALID_DELIMITER")).toBe(
        "this should work",
      );
      expect(settings.variables.get("REGULAR")).toBe("value");
    });

    it("should handle whitespace in delimiter comparison correctly", () => {
      const variablesInput = `TEST_VAR<<EOF
line1
  EOF  
line2
EOF`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // Should not match "  EOF  " but should match exact "EOF"
      expect(settings.variables.get("TEST_VAR")).toBe("line1\n  EOF  \nline2");
    });
  });

  describe("JSON variable parsing", () => {
    it("should parse JSON variables input", () => {
      const jsonInput = JSON.stringify({
        VAR1: "value1",
        VAR2: "value2",
        VAR3: "value with spaces",
      });

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: jsonInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR1")).toBe("value1");
      expect(settings.variables.get("VAR2")).toBe("value2");
      expect(settings.variables.get("VAR3")).toBe("value with spaces");
    });

    it("should parse JSON secrets input", () => {
      const jsonSecrets = JSON.stringify({
        SECRET1: "secretvalue1",
        SECRET2: "secretvalue2",
      });

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            secrets: jsonSecrets,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("SECRET1")).toBe("secretvalue1");
      expect(settings.variables.get("SECRET2")).toBe("secretvalue2");
    });

    it("should handle non-string JSON values by converting to string", () => {
      const jsonInput = JSON.stringify({
        NUMBER_VAR: 42,
        BOOLEAN_VAR: true,
        NULL_VAR: null,
        UNDEFINED_VAR: undefined,
      });

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: jsonInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("NUMBER_VAR")).toBe("42");
      expect(settings.variables.get("BOOLEAN_VAR")).toBe("true");
      expect(settings.variables.has("NULL_VAR")).toBe(false);
      expect(settings.variables.has("UNDEFINED_VAR")).toBe(false);
    });

    it("should fall back to KEY=VALUE parsing for invalid JSON", () => {
      const invalidJson = `{invalid json
      VAR1=fallback_value`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: invalidJson,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR1")).toBe("fallback_value");
    });

    it("should not mistake KEY=VALUE patterns wrapped in braces as JSON", () => {
      const fakeJson = `{VAR1=value1
VAR2=value2}`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: fakeJson,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // Should be parsed as KEY=VALUE, not attempted as JSON
      // The braces become part of the key/value since they're not proper JSON
      expect(settings.variables.get("{VAR1")).toBe("value1");
      expect(settings.variables.get("VAR2")).toBe("value2}");
    });

    it("should not parse arrays as JSON", () => {
      const arrayJson = JSON.stringify(["value1", "value2"]);

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: arrayJson,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // Should be treated as a regular string/fall back to KEY=VALUE parsing
      expect(settings.variables.size).toBeGreaterThanOrEqual(0);
      expect(settings.variables.get("value1")).toBeUndefined();
    });
  });

  describe("Multiple input sources with priority", () => {
    it("should merge variables, secrets, and extra-variables with correct priority", () => {
      vi.stubEnv("ENV_VAR", "env_value");

      const variablesJson = JSON.stringify({
        VAR1: "from_variables",
        VAR2: "from_variables",
        ENV_VAR: "overridden_by_variables",
      });

      const secretsJson = JSON.stringify({
        VAR2: "from_secrets",
        SECRET1: "secret_value",
      });

      const extraVariables = "VAR2=from_extra\nEXTRA_VAR=extra_value";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            secrets: secretsJson,
            "extra-variables": extraVariables,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // Priority: env < variables < secrets < extra-variables
      expect(settings.variables.get("ENV_VAR")).toBe("overridden_by_variables");
      expect(settings.variables.get("VAR1")).toBe("from_variables");
      expect(settings.variables.get("VAR2")).toBe("from_extra"); // extra-variables has highest priority
      expect(settings.variables.get("SECRET1")).toBe("secret_value");
      expect(settings.variables.get("EXTRA_VAR")).toBe("extra_value");
    });

    it("should handle KEY=VALUE format in secrets input", () => {
      const secretsKeyValue = "SECRET1=secret_value1\nSECRET2=secret_value2";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            secrets: secretsKeyValue,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("SECRET1")).toBe("secret_value1");
      expect(settings.variables.get("SECRET2")).toBe("secret_value2");
    });

    it("should handle mixed JSON and KEY=VALUE formats", () => {
      const variablesJson = JSON.stringify({
        JSON_VAR: "json_value",
      });

      const secretsKeyValue = "KEY_VAL_SECRET=keyval_value";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            secrets: secretsKeyValue,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("JSON_VAR")).toBe("json_value");
      expect(settings.variables.get("KEY_VAL_SECRET")).toBe("keyval_value");
    });
  });

  describe("Variable exclusion", () => {
    it("should exclude specified variables", () => {
      const variablesJson = JSON.stringify({
        KEEP_VAR: "keep",
        EXCLUDE_VAR: "should_be_excluded",
        ANOTHER_KEEP: "keep_this",
      });

      const excludeList = "EXCLUDE_VAR\nNONEXISTENT_VAR";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            "exclude-variables": excludeList,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("KEEP_VAR")).toBe("keep");
      expect(settings.variables.get("ANOTHER_KEEP")).toBe("keep_this");
      expect(settings.variables.has("EXCLUDE_VAR")).toBe(false);
    });

    it("should exclude variables from environment, variables, and secrets sources", () => {
      vi.stubEnv("ENV_EXCLUDE", "env_value");

      const variablesJson = JSON.stringify({
        VAR_EXCLUDE: "var_value",
      });

      const secretsJson = JSON.stringify({
        SECRET_EXCLUDE: "secret_value",
      });

      const excludeList = "ENV_EXCLUDE\nVAR_EXCLUDE\nSECRET_EXCLUDE";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            secrets: secretsJson,
            "exclude-variables": excludeList,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.has("ENV_EXCLUDE")).toBe(false);
      expect(settings.variables.has("VAR_EXCLUDE")).toBe(false);
      expect(settings.variables.has("SECRET_EXCLUDE")).toBe(false);
    });

    it("should not exclude extra variables even if listed in exclude-variables", () => {
      const variablesJson = JSON.stringify({
        VAR_TO_EXCLUDE: "var_value",
      });

      const extraVariables = "EXTRA_VAR=extra_value\nVAR_TO_EXCLUDE=extra_override";
      const excludeList = "VAR_TO_EXCLUDE\nEXTRA_VAR";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            "extra-variables": extraVariables,
            "exclude-variables": excludeList,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // VAR_TO_EXCLUDE from variables source should be excluded
      // But when re-added via extra-variables, it should be present
      expect(settings.variables.get("VAR_TO_EXCLUDE")).toBe("extra_override");
      // EXTRA_VAR should be present despite being in exclude list
      expect(settings.variables.get("EXTRA_VAR")).toBe("extra_value");
    });

    it("should handle empty exclude list", () => {
      const variablesJson = JSON.stringify({
        VAR1: "value1",
      });

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            "exclude-variables": "",
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR1")).toBe("value1");
    });

    it("should handle exclude list with empty lines and whitespace", () => {
      const variablesJson = JSON.stringify({
        KEEP: "value",
        EXCLUDE1: "exclude1",
        EXCLUDE2: "exclude2",
      });

      const excludeList = "\n  EXCLUDE1  \n\n  EXCLUDE2  \n  ";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesJson,
            "exclude-variables": excludeList,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("KEEP")).toBe("value");
      expect(settings.variables.has("EXCLUDE1")).toBe(false);
      expect(settings.variables.has("EXCLUDE2")).toBe(false);
    });
  });

  describe("Edge cases and backwards compatibility", () => {
    it("should work with only variables input (backwards compatibility)", () => {
      const variablesInput = "VAR1=value1\nVAR2=value2";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: variablesInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("VAR1")).toBe("value1");
      expect(settings.variables.get("VAR2")).toBe("value2");
    });

    it("should work with no inputs at all", () => {
      vi.spyOn(core, "getInput").mockReturnValue("");
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables).toBeInstanceOf(Map);
    });

    it("should handle HEREDOC in secrets input", () => {
      const secretsInput = `SECRET1<<EOF
multi-line
secret content
EOF
SECRET2=simple_secret`;

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            secrets: secretsInput,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables.get("SECRET1")).toBe(
        "multi-line\nsecret content",
      );
      expect(settings.variables.get("SECRET2")).toBe("simple_secret");
    });

    it("should handle empty JSON object", () => {
      const emptyJson = "{}";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            variables: emptyJson,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      expect(settings.variables).toBeInstanceOf(Map);
    });

    it("should preserve MATCHORY deployment variables", () => {
      vi.stubEnv("GITHUB_REPOSITORY", "owner/test-repo");
      vi.stubEnv("GITHUB_SHA", "abc123def456");

      const excludeList =
        "MATCHORY_DEPLOYMENT_STACK\nMATCHORY_DEPLOYMENT_VERSION";

      vi.spyOn(core, "getInput").mockImplementation(
        (name) =>
          ({
            "stack-name": "my-stack",
            version: "1.0.0",
            "exclude-variables": excludeList,
          })[name] || "",
      );
      vi.spyOn(core, "getBooleanInput").mockReturnValue(false);

      const settings = parseSettings(env);

      // MATCHORY variables should still be present even if in exclude list
      // because they're added after exclusion
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_STACK")).toBe(
        "my-stack",
      );
      expect(settings.variables.get("MATCHORY_DEPLOYMENT_VERSION")).toBe(
        "1.0.0",
      );
    });
  });
});
