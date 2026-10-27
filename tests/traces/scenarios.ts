// What happens on the swarm while a trace is recorded, and what monitoring
// is expected to make of it on replay. Deploys use `docker stack deploy`
// directly, so a trace does not depend on the code it is replayed against.

const image = "busybox:1.37";

export interface Context {
  /** Deploy a Compose file as the stack being recorded, or as `stack` */
  deploy(
    compose: string,
    options?: { wait?: boolean; stack?: string },
  ): Promise<void>;
  /** Remove a stack, waiting until it is gone */
  remove(stack: string): Promise<void>;
  /** Reserve a name for another stack, removed after the run */
  otherStack(): string;
  /** The stack being recorded */
  stack: string;
}

export type Expected =
  | { outcome: "success" }
  | {
      outcome: "failure";
      /** Matches the headline reported for the failing service */
      headline: RegExp;
      /** Matches the error that fails the deployment */
      error?: RegExp;
    };

export interface Scenario {
  name: string;
  /** Runs before recording starts */
  prepare?: (context: Context) => Promise<void>;
  /** The deploy that starts the recording */
  compose: string;
  /** Runs while recording, after the given number of milliseconds */
  during?: { after: number; run: (context: Context) => Promise<void> };
  /** Milliseconds to record after the deploy returned */
  duration: number;
  /** Monitoring settings to replay the trace with */
  replay: { monitorInterval: number; monitorTimeout: number };
  expected: Expected;
  /**
   * The issue tracking why the expected outcome is not the one monitoring
   * should reach, when it is a known gap
   */
  knownGap?: string;
}

function job(mode: string, command: string, restart?: string) {
  return `
services:
  job:
    image: ${image}
    command: ["sh", "-c", "${command}"]
    deploy:
      mode: ${mode}
${restart ? `      restart_policy:\n        condition: ${restart}\n` : ""}`;
}

const sleeping = `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
`;

export const scenarios: Scenario[] = [
  {
    name: "job-success",
    compose: job("replicated-job", "sleep 5"),
    duration: 15_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "success" },
  },
  {
    name: "job-failure",
    compose: job("replicated-job", "sleep 2; exit 3", "none"),
    duration: 10_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "failure", headline: /exited with code 3/ },
  },
  {
    name: "job-retried",
    compose: job("replicated-job", "sleep 1; exit 3"),
    duration: 30_000,
    replay: { monitorInterval: 1, monitorTimeout: 25 },
    expected: {
      outcome: "failure",
      headline: /exited with code 3/,
      error: /timed out after 25s/,
    },
    knownGap: "#244",
  },
  {
    name: "global-job-success",
    compose: job("global-job", "sleep 5"),
    duration: 15_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "success" },
  },
  {
    name: "global-job-failure",
    compose: job("global-job", "sleep 2; exit 3", "none"),
    duration: 10_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "failure", headline: /exited with code 3/ },
  },
  {
    name: "bad-image",
    compose: `
services:
  app:
    image: ${image}-does-not-exist
`,
    duration: 20_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "failure", headline: /Image could not be pulled/ },
  },
  {
    name: "crash-loop",
    compose: `
services:
  app:
    image: ${image}
    command: ["sh", "-c", "exit 2"]
`,
    duration: 30_000,
    replay: { monitorInterval: 1, monitorTimeout: 25 },
    expected: {
      outcome: "failure",
      headline: /exited with code 2/,
      error: /timed out after 25s/,
    },
    knownGap: "#244",
  },
  {
    name: "oom",
    compose: `
services:
  app:
    image: ${image}
    command: ["sh", "-c", "head -c 256m /dev/zero | tail"]
    deploy:
      resources:
        limits:
          memory: 16M
      restart_policy:
        condition: none
`,
    duration: 15_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "failure", headline: /likely OOM/ },
  },
  {
    name: "health-check",
    compose: `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    healthcheck:
      test: ["CMD", "false"]
      interval: 1s
      timeout: 1s
      retries: 1
`,
    duration: 40_000,
    replay: { monitorInterval: 1, monitorTimeout: 35 },
    expected: { outcome: "failure", headline: /failed health check/ },
  },
  {
    name: "update-rollback",
    prepare: ({ deploy }) => deploy(sleeping, { wait: true }),
    compose: `
services:
  app:
    image: ${image}
    command: ["sh", "-c", "sleep 1; exit 4"]
    deploy:
      update_config:
        failure_action: rollback
        monitor: 5s
`,
    duration: 60_000,
    replay: { monitorInterval: 1, monitorTimeout: 55 },
    expected: { outcome: "failure", headline: /exited with code 4/ },
  },
  {
    name: "label-only-update",
    prepare: ({ deploy }) => deploy(sleeping, { wait: true }),
    compose: `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    deploy:
      labels:
        com.matchory.deployment.version: v2
`,
    duration: 10_000,
    replay: { monitorInterval: 1, monitorTimeout: 60 },
    expected: { outcome: "success" },
  },
  {
    name: "unschedulable",
    compose: `
services:
  app:
    image: ${image}
    command: ["sleep", "86400"]
    deploy:
      placement:
        constraints: [node.labels.traces-missing == true]
`,
    duration: 20_000,
    replay: { monitorInterval: 1, monitorTimeout: 15 },
    expected: {
      outcome: "failure",
      headline: /No node available|failed to deploy/,
      error: /timed out after 15s/,
    },
  },
  {
    // Runs long enough for `service ls` to show it as running once
    name: "crash-after-start",
    compose: `
services:
  app:
    image: ${image}
    command: ["sh", "-c", "sleep 3; exit 2"]
`,
    duration: 30_000,
    replay: { monitorInterval: 1, monitorTimeout: 25 },
    expected: { outcome: "success" },
    knownGap: "#247",
  },
  {
    name: "removed-during-rollout",
    compose: `
services:
  app:
    image: ${image}
    command: ["sh", "-c", "exit 2"]
`,
    during: { after: 6_000, run: ({ remove, stack }) => remove(stack) },
    duration: 25_000,
    replay: { monitorInterval: 1, monitorTimeout: 20 },
    expected: { outcome: "success" },
    knownGap: "#247",
  },
  {
    // Swarm hands a freed subnet to the next network while the node still
    // holds it, and rejects the new tasks until it lets go
    name: "pool-overlap",
    prepare: async ({ deploy, remove, otherStack }) => {
      const other = otherStack();

      for (const version of ["1", "2", "3"]) {
        await deploy(`${sleeping}    environment: [VERSION=${version}]\n`, {
          wait: true,
          stack: other,
        });
      }

      await remove(other);
    },
    compose: sleeping,
    duration: 40_000,
    replay: { monitorInterval: 1, monitorTimeout: 35 },
    expected: { outcome: "failure", headline: /Pool overlaps/ },
    knownGap: "#244",
  },
];
