import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exists, interpolateString, sleep } from "../src/utils.js";

// @ts-expect-error -- false positive
const base = fileURLToPath(new URL(".", import.meta.url));

describe("Utilities", () => {
  describe("exists", () => {
    it("should return true for existing files", async () => {
      await expect(exists(`${base}/../package.json`)).resolves.toBe(true);
    });

    it("should return false for non-existing files", async () => {
      await expect(exists("some-missing-file.json")).resolves.toBe(false);
    });
  });

  describe("sleep", () => {
    it("should resolve after the specified time", async () => {
      const start = Date.now();
      await sleep(100);
      const end = Date.now();
      expect(end - start).toBeGreaterThanOrEqual(100);
    });

    it("should resolve immediately if time is 0", async () => {
      const start = Date.now();
      await sleep(0);
      const end = Date.now();
      expect(end - start).toBeLessThan(100);
    });
  });

  describe("interpolateString", () => {
    describe("Basic variable substitution", () => {
      it("should replace simple variables with $VARIABLE format", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("Hello $NAME", variables)).toBe("Hello John");
      });

      it("should replace simple variables with ${VARIABLE} format", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("Hello ${NAME}", variables)).toBe(
          "Hello John",
        );
      });

      it("should replace multiple variables in one string", () => {
        const variables = new Map([
          ["FIRST", "John"],
          ["LAST", "Doe"],
        ]);
        expect(interpolateString("Hello $FIRST ${LAST}!", variables)).toBe(
          "Hello John Doe!",
        );
      });

      it("should handle variables with underscores", () => {
        const variables = new Map([["USER_NAME", "john_doe"]]);
        expect(interpolateString("User: $USER_NAME", variables)).toBe(
          "User: john_doe",
        );
      });

      it("should return empty string for undefined variables", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("Hello $NAME", variables)).toBe("Hello ");
      });

      it("should handle empty variable values", () => {
        const variables = new Map([["EMPTY", ""]]);
        expect(interpolateString("Value: $EMPTY", variables)).toBe("Value: ");
      });

      it("should handle strings with no variables", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("No variables here", variables)).toBe(
          "No variables here",
        );
      });
    });

    describe("Default value substitution", () => {
      it("should use default value with - operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME-default}", variables)).toBe("default");
      });

      it("should use default value with :- operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME:-default}", variables)).toBe(
          "default",
        );
      });

      it("should use default value with :- operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("${NAME:-default}", variables)).toBe(
          "default",
        );
      });

      it("should use variable value with - operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("${NAME-default}", variables)).toBe("");
      });

      it("should use variable value with - operator when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME-default}", variables)).toBe("John");
      });

      it("should use variable value with :- operator when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME:-default}", variables)).toBe("John");
      });

      it("should handle empty default values", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME-}", variables)).toBe("");
      });

      it("should handle complex default values", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME-hello world}", variables)).toBe(
          "hello world",
        );
      });
    });

    describe("Alternative value substitution", () => {
      it("should use default value with + operator when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME+alternative}", variables)).toBe(
          "alternative",
        );
      });

      it("should use default value with :+ operator when variable is defined and non-empty", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME:+alternative}", variables)).toBe(
          "alternative",
        );
      });

      it("should return empty string with + operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME+alternative}", variables)).toBe("");
      });

      it("should return empty string with :+ operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${NAME:+alternative}", variables)).toBe("");
      });

      it("should use default value with + operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("${NAME+alternative}", variables)).toBe(
          "alternative",
        );
      });

      it("should return empty string with :+ operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("${NAME:+alternative}", variables)).toBe("");
      });

      it("should handle empty alternative values", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME+}", variables)).toBe("");
      });
    });

    describe("Required value substitution", () => {
      it("should throw error with ? operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(() =>
          interpolateString("${NAME?error message}", variables),
        ).toThrow(
          "Failed to resolve variable NAME: Missing required value: error message",
        );
      });

      it("should throw error with :? operator when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(() =>
          interpolateString("${NAME:?error message}", variables),
        ).toThrow(
          "Failed to resolve variable NAME: Missing required value: error message",
        );
      });

      it("should throw error with :? operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(() =>
          interpolateString("${NAME:?error message}", variables),
        ).toThrow(
          "Failed to resolve variable NAME: Missing required value: error message",
        );
      });

      it("should use variable value with ? operator when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("${NAME?error message}", variables)).toBe("");
      });

      it("should use variable value with ? operator when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME?error message}", variables)).toBe(
          "John",
        );
      });

      it("should use variable value with :? operator when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("${NAME:?error message}", variables)).toBe(
          "John",
        );
      });

      it("should handle empty error messages", () => {
        const variables = new Map<string, string>();
        expect(() => interpolateString("${NAME?}", variables)).toThrow(
          "Failed to resolve variable NAME: Missing required value: ",
        );
      });
    });

    describe("Escaping", () => {
      it("should not replace escaped variables with $$", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("$$NAME", variables)).toBe("$$NAME");
      });

      it("should not replace escaped variables with $${}", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("$${NAME}", variables)).toBe("$${NAME}");
      });

      it("should handle mix of escaped and unescaped variables", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("Hello $NAME and $$NAME", variables)).toBe(
          "Hello John and $$NAME",
        );
      });

      it("should handle escaped variables with operators", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("$${NAME:-default}", variables)).toBe(
          "$${NAME:-default}",
        );
      });
    });

    describe("Strict mode", () => {
      it("should throw error in strict mode when variable is undefined", () => {
        const variables = new Map<string, string>();
        expect(() => interpolateString("Hello $NAME", variables, true)).toThrow(
          "Variable NAME is required but not defined",
        );
      });

      it("should not throw error in strict mode when variable is defined", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("Hello $NAME", variables, true)).toBe(
          "Hello John",
        );
      });

      it("should not throw error in strict mode when variable is empty", () => {
        const variables = new Map([["NAME", ""]]);
        expect(interpolateString("Hello $NAME", variables, true)).toBe(
          "Hello ",
        );
      });

      it("should not throw error in strict mode when using default values", () => {
        const variables = new Map<string, string>();
        expect(
          interpolateString("Hello ${NAME:-default}", variables, true),
        ).toBe("Hello default");
      });

      it("should not throw error in strict mode when using alternative values", () => {
        const variables = new Map<string, string>();
        expect(
          interpolateString("Hello ${NAME:+alternative}", variables, true),
        ).toBe("Hello ");
      });

      it("should handle multiple undefined variables in strict mode", () => {
        const variables = new Map<string, string>();
        expect(() =>
          interpolateString("Hello $NAME $SURNAME", variables, true),
        ).toThrow("Variable NAME is required but not defined");
      });
    });

    describe("Edge cases", () => {
      it("should handle empty strings", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("", variables)).toBe("");
      });

      it("should handle strings with only dollar signs", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("$", variables)).toBe("$");
      });

      it("should handle malformed variable syntax", () => {
        const variables = new Map<string, string>();
        expect(interpolateString("${", variables)).toBe("${");
      });

      it("should handle variables with special characters (should not match)", () => {
        const variables = new Map([["VAR", "value"]]);
        expect(interpolateString("$VAR-NAME", variables)).toBe("value-NAME");
      });

      it("should handle variables at the beginning of string", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("$NAME is here", variables)).toBe(
          "John is here",
        );
      });

      it("should handle variables at the end of string", () => {
        const variables = new Map([["NAME", "John"]]);
        expect(interpolateString("Hello $NAME", variables)).toBe("Hello John");
      });

      it("should handle consecutive variables", () => {
        const variables = new Map([
          ["A", "Hello"],
          ["B", "World"],
        ]);
        expect(interpolateString("$A$B", variables)).toBe("HelloWorld");
      });
    });

    describe("Recursive interpolation", () => {
      it("should handle recursive interpolation scenarios", () => {
        const variables = new Map([
          ["BASE", "Hello"],
          ["MESSAGE", "$BASE World"],
        ]);
        expect(interpolateString("$MESSAGE", variables)).toBe("Hello World");
      });

      it("should handle multiple levels of recursion", () => {
        const variables = new Map([
          ["A", "Hello"],
          ["B", "$A World"],
          ["C", "$B!"],
        ]);
        expect(interpolateString("$C", variables)).toBe("Hello World!");
      });

      it("should handle recursive interpolation with operators", () => {
        const variables = new Map([
          ["BASE", "Hello"],
          ["MESSAGE", "${BASE:-Default} World"],
        ]);
        expect(interpolateString("$MESSAGE", variables)).toBe("Hello World");
      });

      it("should handle recursion with undefined variables", () => {
        const variables = new Map([["MESSAGE", "$UNDEFINED World"]]);
        expect(interpolateString("$MESSAGE", variables)).toBe(" World");
      });
    });

    describe("Complex scenarios", () => {
      it("should handle complex strings with multiple operator types", () => {
        const variables = new Map([
          ["DEFINED", "value"],
          ["EMPTY", ""],
        ]);
        const template =
          "A:${DEFINED:-default} B:${UNDEFINED:-fallback} C:${EMPTY:-empty} D:${DEFINED:+present}";
        expect(interpolateString(template, variables)).toBe(
          "A:value B:fallback C:empty D:present",
        );
      });

      it("should handle real-world configuration template", () => {
        const variables = new Map([
          ["HOST", "localhost"],
          ["PORT", "8080"],
          ["DEBUG", "true"],
        ]);
        const template =
          "server=${HOST:-127.0.0.1}:${PORT:-3000} debug=${DEBUG:+enabled}";
        expect(interpolateString(template, variables)).toBe(
          "server=localhost:8080 debug=enabled",
        );
      });

      it("should handle Docker Compose-like syntax", () => {
        const variables = new Map([
          ["POSTGRES_DB", "myapp"],
          ["POSTGRES_USER", "user"],
        ]);
        const template =
          "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD:-secret}@db:5432/${POSTGRES_DB}";
        expect(interpolateString(template, variables)).toBe(
          "postgresql://user:secret@db:5432/myapp",
        );
      });

      it("should handle environment variable patterns", () => {
        const variables = new Map([
          ["NODE_ENV", "production"],
          ["PORT", "8080"],
        ]);
        const template =
          "Starting server on port ${PORT:-3000} in ${NODE_ENV:-development} mode";
        expect(interpolateString(template, variables)).toBe(
          "Starting server on port 8080 in production mode",
        );
      });

      it("should handle mixed escaping and substitution", () => {
        const variables = new Map([
          ["REAL_VAR", "value"],
          ["ESCAPED_VAR", "should not appear"],
        ]);
        const template =
          "Real: $REAL_VAR, Escaped: $$ESCAPED_VAR, Mixed: ${REAL_VAR:-default}";
        expect(interpolateString(template, variables)).toBe(
          "Real: value, Escaped: $$ESCAPED_VAR, Mixed: value",
        );
      });
    });

    describe("Error handling", () => {
      it("should include variable name in error message for required variables", () => {
        const variables = new Map<string, string>();
        expect(() =>
          interpolateString("${MISSING_VAR?Custom error}", variables),
        ).toThrow("Failed to resolve variable MISSING_VAR");
      });

      it("should include custom error message for required variables", () => {
        const variables = new Map<string, string>();
        expect(() =>
          interpolateString("${MISSING_VAR?Custom error}", variables),
        ).toThrow("Missing required value: Custom error");
      });

      it("should handle error propagation properly", () => {
        const variables = new Map<string, string>();
        expect(() => interpolateString("${VAR:?}", variables)).toThrow(
          "Failed to resolve variable VAR: Missing required value: ",
        );
      });

      it("should handle strict mode errors with clear messages", () => {
        const variables = new Map<string, string>();
        expect(() => interpolateString("$UNDEFINED", variables, true)).toThrow(
          "Variable UNDEFINED is required but not defined",
        );
      });
    });

    describe("Performance and edge cases", () => {
      it("should handle very long strings efficiently", () => {
        const variables = new Map([["VAR", "replacement"]]);
        const longString =
          "prefix ".repeat(1000) + "$VAR" + " suffix".repeat(1000);
        const result = interpolateString(longString, variables);
        expect(result).toContain("replacement");
        expect(result).not.toContain("$VAR");
      });

      it("should handle many variables efficiently", () => {
        const variables = new Map<string, string>();
        let template = "";
        for (let i = 0; i < 100; i++) {
          variables.set(`VAR${i}`, `value${i}`);
          template += `$VAR${i} `;
        }
        const result = interpolateString(template, variables);
        expect(result).toContain("value0");
        expect(result).toContain("value99");
      });

      it("should handle case sensitivity correctly", () => {
        const variables = new Map([
          ["var", "lowercase"],
          ["VAR", "uppercase"],
        ]);
        expect(interpolateString("$var $VAR", variables)).toBe(
          "lowercase uppercase",
        );
      });

      it("should handle whitespace in variable names (should not match)", () => {
        const variables = new Map([["VAR NAME", "value"]]);
        expect(interpolateString("$VAR NAME", variables)).toBe(" NAME");
      });
    });
  });
});
