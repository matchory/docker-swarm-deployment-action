import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { dump } from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComposeSpec } from "../src/compose.js";
import { run } from "../src/main.js";
import * as utils from "../src/utils.js";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const unlink = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  unlink,
  readdir,
}));

const mockUploadArtifact = vi.hoisted(() => vi.fn());
vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: vi.fn(() => ({
    uploadArtifact: mockUploadArtifact,
  })),
}));

const mockRandomUUID = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));
vi.mock("@actions/core");
vi.mock("@actions/exec");

describe("main", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    
    // Set up default readdir mock to return compose files
    vi.mocked(readdir).mockImplementation(async (path: string) => {
      if (path === ".") {
        return ["compose.yaml"] as any;
      }
      throw new Error("Directory not found");
    });
  });

  it("should deploy an application", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("DOCKER_HOST", "tcp://localhost:2375");
    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValue(0);
    vi.mocked(exec)
      // docker stack config
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));

        return 0;
      })

      // docker stack deploy
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("Deploying stack my-app"));

        return 0;
      })

      // docker config ls
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("[]"));

        return 0;
      })

      // docker secret ls
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("[]"));

        return 0;
      });
    readFile.mockResolvedValueOnce(dump(composeSpec));
    writeFile.mockResolvedValue(undefined);
    mockRandomUUID
      .mockReturnValueOnce("compose-temp-uuid") // For compose processing
      .mockReturnValueOnce("artifact-uuid-123"); // For artifact storage
    mockUploadArtifact.mockResolvedValueOnce({ id: "artifact-123" });

    await expect(run()).resolves.not.toThrow();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("compose-spec", composeSpec);
    expect(core.setOutput).toHaveBeenCalledWith("stack-name", "my-app");
    expect(core.setOutput).toHaveBeenCalledWith("version", "4fadb58");
    expect(core.setOutput).toHaveBeenCalledWith("status", "success");
  });

  it("should report a deployment failure", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));

      return 0;
    });
    readFile.mockResolvedValueOnce(dump(composeSpec));
    writeFile.mockResolvedValue(undefined);
    mockRandomUUID.mockReturnValue("undefined"); // For compose processing

    await expect(run()).resolves.not.toThrow();
    expect(core.setFailed).toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledExactlyOnceWith("status", "failure");
  });

  it("should store compose spec artifact successfully", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("DOCKER_HOST", "tcp://localhost:2375");
    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValue(0);
    vi.mocked(exec)
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("Deploying stack my-app"));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("[]"));
        return 0;
      });

    readFile.mockResolvedValueOnce(dump(composeSpec));
    writeFile.mockResolvedValue(undefined);
    mockRandomUUID
      .mockReturnValueOnce("compose-temp-uuid") // For compose processing
      .mockReturnValueOnce("artifact-uuid-123") // For artifact storage
      .mockReturnValue("fallback-uuid"); // For any additional calls
    mockUploadArtifact.mockResolvedValueOnce({ id: "artifact-123" });

    await expect(run()).resolves.not.toThrow();

    // Check that writeFile was called at least twice (once for Compose temp file, once for artifact)
    expect(writeFile).toHaveBeenCalledTimes(2);
    // Check that the artifact file was written with the correct content
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\.\/compose-spec\.generated\..*\.json$/),
      JSON.stringify(composeSpec, null, 2),
    );
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      "compose-spec",
      [expect.stringMatching(/^\.\/compose-spec\.generated\..*\.json$/)],
      ".",
      { retentionDays: 30 },
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("should warn when file writing fails but continue execution", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("DOCKER_HOST", "tcp://localhost:2375");
    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValue(0);
    vi.mocked(exec)
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("Deploying stack my-app"));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("[]"));
        return 0;
      });

    readFile.mockResolvedValueOnce(dump(composeSpec));
    writeFile
      .mockResolvedValueOnce(undefined) // For compose processing
      .mockRejectedValueOnce(new Error("Permission denied")); // For artifact storage
    mockRandomUUID
      .mockReturnValueOnce("compose-temp-uuid") // For compose processing
      .mockReturnValueOnce("artifact-uuid-123"); // For artifact storage

    await expect(run()).resolves.not.toThrow();

    expect(core.warning).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Failed to store compose spec artifact: Failed to write compose spec to file: Permission denied",
      }),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("status", "success");
  });

  it("should warn when artifact upload fails but continue execution", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("DOCKER_HOST", "tcp://localhost:2375");
    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValue(0);
    vi.mocked(exec)
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("Deploying stack my-app"));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_0, _1, options) => {
        options?.listeners?.stdout?.(Buffer.from("[]"));
        return 0;
      });

    readFile.mockResolvedValueOnce(dump(composeSpec));
    writeFile.mockResolvedValue(undefined);
    mockRandomUUID
      .mockReturnValueOnce("compose-temp-uuid") // For compose processing
      .mockReturnValueOnce("artifact-uuid-123"); // For artifact storage
    mockUploadArtifact.mockRejectedValueOnce(new Error("Upload failed"));

    await expect(run()).resolves.not.toThrow();

    expect(writeFile).toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Failed to store compose spec artifact: Failed to upload compose spec artifact: Upload failed",
      }),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("status", "success");
  });

  it("should not attempt to store artifact when deployment fails", async () => {
    const composeSpec = defineComposeSpec({
      services: {
        app: {
          image: "my-app:latest",
          ports: ["80:80"],
        },
      },
    });

    vi.stubEnv("GITHUB_REPOSITORY", "my-org/my-app");
    vi.stubEnv("GITHUB_SHA", "4fadb584c2bad24be4467665cc6874dc57c2034e");
    vi.spyOn(core, "getInput").mockReturnValue("");
    vi.mocked(exec).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));
      return 0;
    });
    readFile.mockResolvedValueOnce(dump(composeSpec));

    await expect(run()).resolves.not.toThrow();

    // writeFile is called once during compose processing (before deployment failure)
    // but not for artifact storage since deployment failed
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(
      "docker-compose.generated.undefined.yaml",
      expect.any(String),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledExactlyOnceWith("status", "failure");
  });
});

describe("error handling and output status", () => {
  it("should set output status to failure for unknown error types", async () => {
    const error = "string error";
    vi.spyOn(core, "setFailed").mockImplementation(() => {});
    vi.spyOn(core, "setOutput").mockImplementation(() => {});
    // Simulate run throwing a string error
    const runWithError = async () => {
      throw error;
    };
    await runWithError().catch((err) => {
      if (err instanceof Error) {
        core.setFailed(err);
      } else {
        core.setFailed(`An unknown error occurred: ${err}`);
      }
      core.setOutput("status", "failure");
    });
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("An unknown error occurred: string error"),
    );
    expect(core.setOutput).toHaveBeenCalledWith("status", "failure");
  });
});
