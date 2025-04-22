import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { dump } from "js-yaml";
import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { defineComposeSpec } from "../src/compose.js";
import { run } from "../src/main.js";
import * as utils from "../src/utils.js";

const readFile = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const unlink = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  unlink,
}));
vi.mock("@actions/core");
vi.mock("@actions/exec");

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe("main", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
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
    vi.spyOn(utils, "exists").mockResolvedValueOnce(true);
    vi.mocked(exec).mockResolvedValue(0);
    vi.mocked(exec).mockImplementation(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));

      return 0;
    });
    readFile.mockResolvedValueOnce(dump(composeSpec));

    server.use(
      http.get("http://localhost:2375/configs", () => HttpResponse.json([])),
      http.get("http://localhost:2375/secrets", () => HttpResponse.json([])),
    );

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
    vi.spyOn(utils, "exists").mockResolvedValueOnce(true);
    vi.mocked(exec).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    vi.mocked(exec).mockImplementationOnce(async (_0, _1, options) => {
      options?.listeners?.stdout?.(Buffer.from(dump(composeSpec)));

      return 0;
    });
    readFile.mockResolvedValueOnce(dump(composeSpec));

    await expect(run()).resolves.not.toThrow();
    expect(core.setFailed).toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledExactlyOnceWith("status", "failure");
  });
});
