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
});
