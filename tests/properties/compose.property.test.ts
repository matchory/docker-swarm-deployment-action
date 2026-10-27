import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ComposeSpec } from "../../src/compose.js";
import {
  healthCheckWarningsLabel,
  monitorLabel,
  monitorTimeoutLabel,
} from "../../src/labels.js";
import { image, inputs, interpolation, labelValue } from "./arbitraries.js";
import {
  budget,
  composeConfig,
  deploymentLabels,
  dockerAvailable,
  runPipeline,
  stackConfig,
} from "./pipeline.js";

vi.mock("@actions/core");

const suite = (await dockerAvailable()) ? describe : describe.skip;

// Where the action deliberately departs from Compose; see the README section
// "Selecting Services with Profiles"
const refusals = [
  // A stack cannot extend a service it does not deploy
  /extends service "\w+", which is not deployed/,
];

// Compose accepts a project without services; a stack needs one
const noServices = /(has no|have any) services to deploy/;

suite(
  "Compose processing against Docker",
  { timeout: budget.numRuns * 10_000 },
  () => {
    it("deploys the services Compose selects", async () => {
      await fc.assert(
        fc.asyncProperty(inputs, async (input) => {
          const action = await runPipeline(input);
          const compose = await composeConfig(input);

          if (action.ok && compose.ok) {
            expect(
              Object.keys(action.value.normalized.services).sort(),
            ).toEqual(Object.keys(compose.value.services ?? {}).sort());
          } else if (compose.ok && !action.ok) {
            const empty =
              Object.keys(compose.value.services ?? {}).length === 0;
            expect(
              refusals.some((refusal) => refusal.test(action.error)) ||
                (empty && noServices.test(action.error)),
              action.error,
            ).toBe(true);
          } else if (action.ok && !compose.ok) {
            // Compose rejects a dependency on a skipped service; the action
            // removes it with a warning, as Swarm ignores dependencies anyway
            expect(compose.error).toMatch(/depends on undefined service/);
            expect(action.warnings).toContainEqual(
              expect.stringMatching(
                /depends on service "\w+", which is not deployed/,
              ),
            );
          }
        }),
        budget,
      );
    });

    it("merges files as Compose does", async () => {
      await fc.assert(
        fc.asyncProperty(inputs, async (input) => {
          const action = await runPipeline(input);
          const compose = await composeConfig(input);

          // Differences in the selected services are the profile property's
          if (!action.ok || !compose.ok) {
            return;
          }

          const merged = projection(action.value.final);
          const expected = projection(compose.value);

          if (sameKeys(merged, expected)) {
            expect(merged).toEqual(expected);
          }
        }),
        budget,
      );
    });

    it("produces specs Docker accepts", async () => {
      await fc.assert(
        fc.asyncProperty(inputs, async (input) => {
          const action = await runPipeline(input);

          if (action.ok) {
            const docker = await stackConfig(
              action.value.final,
              input.variables,
            );
            expect(docker.ok, docker.ok ? "" : docker.error).toBe(true);
          }
        }),
        budget,
      );
    });

    it("deploys variable values unchanged", async () => {
      await fc.assert(
        fc.asyncProperty(interpolation, async ({ value, keyInterpolation }) => {
          const action = await runPipeline({
            files: [
              {
                services: {
                  app: {
                    image,
                    environment: { VALUE: "${VALUE}" },
                    deploy: {
                      labels: { value: "${VALUE}", "key.${SUFFIX}": "key" },
                    },
                  },
                },
              } as ComposeSpec,
            ],
            keyInterpolation,
            variables: { VALUE: value, SUFFIX: "suffix" },
          });
          expect(action.ok, action.ok ? "" : action.error).toBe(true);

          // `docker stack deploy` interpolates the spec it is given once more
          const docker = await stackConfig(
            (action as { value: { final: ComposeSpec } }).value.final,
            { VALUE: value, SUFFIX: "suffix" },
          );
          expect(docker.ok, docker.ok ? "" : docker.error).toBe(true);

          const app = (docker as { value: ComposeSpec }).value.services
            .app as Service;
          expect(asMap(app.environment).VALUE).toBe(value);
          expect(app.deploy?.labels).toMatchObject({ value });
          expect(app.deploy?.labels).toHaveProperty(
            keyInterpolation ? "key.suffix" : "key.${SUFFIX}",
          );
        }),
        budget,
      );
    });

    it("puts deployment labels on services only", async () => {
      await fc.assert(
        fc.asyncProperty(inputs, async (input) => {
          const action = await runPipeline(input);

          if (!action.ok) {
            return;
          }

          for (const service of Object.values(
            action.value.final.services,
          ) as Service[]) {
            expect(service.deploy?.labels).toMatchObject(deploymentLabels);

            for (const label of Object.keys(asMap(service.labels))) {
              expect(label).not.toMatch(/^com\.matchory\.deployment\./);
            }
          }
        }),
        budget,
      );
    });

    it("accepts only service labels Docker accepts", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record(
            {
              [monitorLabel]: labelValue,
              [monitorTimeoutLabel]: labelValue,
              [healthCheckWarningsLabel]: labelValue,
            },
            { requiredKeys: [] },
          ),
          async (labels) => {
            const action = await runPipeline({
              files: [
                {
                  services: { app: { image, deploy: { labels } } },
                } as ComposeSpec,
              ],
            });

            if (action.ok) {
              const docker = await stackConfig(action.value.final);
              expect(docker.ok, docker.ok ? "" : docker.error).toBe(true);
            }
          },
        ),
        budget,
      );
    });
  },
);

interface Service {
  image?: string;
  command?: unknown;
  environment?: unknown;
  labels?: unknown;
  deploy?: { labels?: Record<string, string>; replicas?: number };
}

// The fields both Docker's merge and Compose's normalize the same way
function projection(spec: ComposeSpec) {
  return Object.fromEntries(
    Object.entries(spec.services ?? {}).map(([name, value]) => {
      const service = value as Service;
      const deployLabels = asMap(service.deploy?.labels);

      for (const label of Object.keys(deploymentLabels)) {
        delete deployLabels[label];
      }

      return [
        name,
        {
          image: service.image,
          // Compose writes `null` for a command the service does not set
          command: service.command ?? undefined,
          environment: asMap(service.environment),
          labels: asMap(service.labels),
          deployLabels,
          replicas: service.deploy?.replicas,
        },
      ];
    }),
  );
}

// Environment and labels may be a mapping or a list of `KEY=value`
function asMap(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const [key, ...rest] = String(entry).split("=");

        return [key, rest.join("=")];
      }),
    );
  }

  return Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>).map(
      ([key, entry]) => [key, entry === null ? "" : String(entry)],
    ),
  );
}

function sameKeys(a: object, b: object) {
  return (
    JSON.stringify(Object.keys(a).sort()) ===
    JSON.stringify(Object.keys(b).sort())
  );
}
