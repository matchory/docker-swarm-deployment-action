# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when
working with code in this repository.

## Project

GitHub Action for deploying Docker Swarm stacks with automatic
config/secret management, variable rotation, and optional
post-deployment monitoring. Written in TypeScript, runs on Node 24.

## Commands

| Task               | Command                                |
| ------------------ | -------------------------------------- |
| Package (TS->dist) | `npm run package`                      |
| Run tests          | `npm run test`                         |
| Run single test    | `npx vitest run tests/compose.test.ts` |
| Run swarm tests    | `npm run test:swarm`                   |
| More property runs | `PROPERTY_RUNS=1000 npm run test`      |
| Typecheck          | `npm run typecheck`                    |
| Lint               | `npm run lint`                         |
| Format check       | `npm run format:check`                 |
| Format fix         | `npm run format:write`                 |
| Full pipeline      | `npm run all`                          |

The `dist/` directory is committed. Run `npm run package` after
source changes. Always run `npm run all` before pushing to verify
the full pipeline passes (format, lint, typecheck, test, package).

## Architecture

**Build chain**: `src/*.ts` -> esbuild (`script/bundle.mjs`) -> `dist/`

esbuild parses TypeScript directly -- no intermediate compile step.
The output is ESM (`"type": "module"` in dist/package.json).
The GitHub Actions runner loads `dist/index.js`, a two-line entry
point that turns on source map support and imports the real bundle
in `dist/main.js`. Node only applies source maps to modules compiled
after the switch is flipped, so the flip cannot live in the bundle
itself. `script/bundle.mjs` also writes `dist/licenses.txt` from the
packages esbuild actually pulled in.

**Deployment flow** (orchestrated in `deployment.ts`):

1. `resolveComposeFiles()` -- find compose files
2. `readStackSettings()` + `applyStackSettings()` -- apply the
   `x-matchory-deployment` block (inputs still win)
3. `loadComposeSpecs()` -- parse YAML, select profiles, process
   configs/secrets (`prepareSpec`), inline env files
4. `normalizeSpec()` -- reconcile for Swarm and merge, then validate
   via `docker stack config` (merges with `docker compose config`
   first when `!reset`/`!override` tags or `extends` are present)
5. `interpolateSpec()` -- substitute `${VAR}` references
6. `assertOwnShares()`, `resolveServiceOptions()`,
   `validateHealthChecks()`, `addDeploymentLabels()` -- checks and
   service labels on the final spec
7. `deployStack()` -- run `docker stack deploy` with spec on stdin
8. `monitorDeployment()` -- optional polling of service task states
9. `pruneVariables()` -- remove unused configs/secrets

With the `destroy` input, `main.ts` calls `destroy()` in
`teardown.ts` instead, and none of the above runs.

**Key modules**:

- `settings.ts` -- parses GitHub Actions inputs; merges variables
  from env, `variables`, `secrets`, and `extra-variables` inputs;
  resolves stack settings
- `variables.ts` -- config/secret management: hash-based rotation,
  file/env/content sources, base64/hex transforms, pruning
- `engine.ts` -- Docker CLI wrapper: stack deploy, compose config,
  service/secret/config listing, task listing
- `compose.ts` -- compose file resolution, YAML loading,
  normalization, spec interpolation
- `utils.ts` -- `interpolateString()`, the interpolation engine
- `reconcile.ts` -- Compose-Spec-to-Swarm translation and stripping,
  `strict-compatibility`
- `profiles.ts` -- Compose profile selection
- `env-file.ts` -- `env_file` parsing and inlining (dotenv rules)
- `override-tags.ts` -- `!reset`/`!override` YAML tag support
- `labels.ts` -- service labels: per-service settings and
  deployment labels
- `healthcheck.ts` -- health check warnings and report details
- `shares.ts` -- rejects volumes naming another stack's share
- `teardown.ts` -- the `destroy` input
- `monitoring.ts` -- polls service tasks until convergence or
  timeout, with structured failure diagnostics and early failure
  detection via `isServiceStuck()`
- `main.ts` -- entry point: calls `deploy()` or `destroy()`, sets
  action outputs, uploads compose spec artifact

## Monitoring and failure diagnostics

When monitoring is enabled and a service fails, `buildFailureReport`
produces structured output: categorized error headline, task attempt
history (from `docker service ps`), and container logs. The error
categorization in `categorizeTaskError` covers 12 failure types
(image pull, crash, OOM, health check, scheduling, etc.).

`isServiceStuck` detects when all tasks are in terminal failure
states (Failed/Rejected) and bails early instead of waiting for the
full timeout. This matters for first deploys with bad images where
Docker never triggers a rollback.

## CI

These workflows run on pull requests and pushes to main: `ci.yml`
(tests), `linter.yml` (super-linter), `licensed.yml` (license
compliance), `check-dist.yml` (rebuilds `dist/` and fails if the
committed bundle is stale), `codeql-analysis.yml`, and `swarm.yml`
(swarm scenarios, below; only when runtime files change).

`swarm.yml` runs `tests/swarm` against a real single-node swarm,
one matrix job per file, plus a smoke job that runs the committed
action through `uses: ./`. The harness (`tests/swarm/harness.ts`)
runs `node dist/index.js` with `INPUT_*` variables and the
defaults from `action.yml`, and passes only a minimal environment,
because every environment variable becomes a deployment variable.
Locally, the scenarios run against the current Docker context;
build `dist/` first.

`tests/properties` holds differential property tests (fast-check):
generated Compose files go through the action's pipeline in-process
and are checked against `docker compose config` and `docker stack
config`, which need Docker but no swarm. They run in the regular
suite with a fixed seed and 25 cases per property;
`properties.yml`, triggered by hand, runs 1000 random ones. Generators live in `tests/properties/arbitraries.ts`;
extend the grammar when a bug is found outside it, and keep the
shrunk counterexample as a unit test.

`dist/` and `.licenses/` are both derived from `package-lock.json`,
so a dependency bump alone makes `check-dist.yml` and
`licensed.yml` fail. `regenerate-artifacts.yml` handles that: it
runs on pushes to main that touch `package.json` or
`package-lock.json`, regenerates both, and opens a pull request.
It runs post-merge rather than on the Dependabot PR because
Dependabot-triggered runs get a read-only token. The commit and
pull request come from the org's reusable `signed-pull-request.yml`
workflow in `matchory/.github`, using the gh-actions-token-provider
app, so the commit is signed and the usual checks run on the pull
request.

`licensed.yml` only reports; it never writes to `.licenses/`.

Super-linter excludes `dist/`, `docs/superpowers/`, and
`.licenses/` directories. Markdown files must follow the config in
`.github/linters/.markdown-lint.yml` (120 char line length, tables
exempt, dash bullets, underscore emphasis).

`release.yml` triggers on SemVer tags (`v*.*.*`), updates rolling
`vN` and `vN.N` tags, and creates a GitHub release.

## Tooling

- **Biome** for linting and formatting (not ESLint/Prettier)
- **Vitest** for testing with V8 coverage
- **esbuild** bundles TypeScript source into a single ESM file
- TypeScript strict mode, ESNext target, bundler module resolution

TypeScript is version 7, the native compiler, and is only ever a
typechecker here: `tsc --noEmit`. It ships no JavaScript API, so no
build tooling can drive it. This is what ruled out @vercel/ncc, which
compiled through that API and is frozen at 0.44.1. Reach for a tool
that parses TypeScript itself rather than one that loads
`typescript`. `tsserver` is gone too -- editors need an LSP client.

## Gotchas

- `npm ci` will fail if `package-lock.json` is out of sync. After
  changing dependencies, always run `npm install` to update it.
- `getServiceLogs` uses `--raw --timestamps` (no `--details`).
  The parser splits on first space only: `[timestamp] [message]`.
  There is no metadata field.
- `docker stack deploy --detach=true` returns before services
  converge. Failure detection only works with `monitor: true`.
- The `config` error pattern in `categorizeTaskError` requires
  "secret" or "config" context around "not found" to avoid false
  positives on generic "not found" errors.
- Node applies source maps to stack _frames_ but not to the code frame
  it prints above them, so an uncaught throw dumps the raw generated
  line into the Actions log. `lineLimit: 500` in `script/bundle.mjs`
  keeps that to a few thousand characters at worst instead of a quarter
  megabyte; the limit is soft, so some lines still overshoot it.
  Prefer failing through `core.setFailed` so it never comes up.
- Compose resolves `extends` within the file that writes it,
  against that file's definition of the base, before merging the
  files. `docker stack config` rejects `extends` outright, so a
  spec using it is merged with `docker compose config`, like one
  with merge tags. Profile selection and env-file inlining replay
  the merge themselves and must follow the per-file rule.
- Swarm reuses a freed overlay subnet immediately. Deploying a
  stack right after removing one whose services were updated gets
  its tasks rejected with "Pool overlaps with other one on this
  address space" for about 20s. The swarm tests therefore remove
  their stacks only after the last file (`global-setup.ts`).
- `docker stack rm --detach=false` with several stack names has
  hung after removing all but the last. Remove one per call. It
  also fails on a network still attached to a stopping task and
  leaves the network behind; calling it again removes it.
- Swarm prefixes task errors with the exit code, e.g. `task:
  non-zero exit (137): dockerexec: unhealthy container`, so the
  exit-code patterns in `categorizeTaskError` must stay last.
- `script/bundle.mjs` builds with `write: false` and only clears
  `dist/` once the bundle and the license scan have both succeeded --
  a build error must not leave the committed directory half deleted.
