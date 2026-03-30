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
| Typecheck          | `npm run typecheck`                    |
| Lint               | `npm run lint`                         |
| Format check       | `npm run format:check`                 |
| Format fix         | `npm run format:write`                 |
| Full pipeline      | `npm run all`                          |

The `dist/` directory is committed. Run `npm run package` after
source changes. Always run `npm run all` before pushing to verify
the full pipeline passes (format, lint, typecheck, test, package).

## Architecture

**Build chain**: `src/*.ts` -> @vercel/ncc (`dist/index.js`)

ncc bundles TypeScript directly -- no intermediate compile step.
The output is ESM (`"type": "module"` in dist/package.json).
The GitHub Actions runner loads it via `node dist/index.js`.

**Deployment flow** (orchestrated in `deployment.ts`):

1. `resolveComposeFiles()` -- find compose files
2. `loadComposeSpecs()` -- parse YAML
3. `normalizeSpec()` -- validate via `docker stack config`
4. `interpolateSpec()` -- substitute `${VAR}` references
5. `deployStack()` -- run `docker stack deploy` with spec on stdin
6. `monitorDeployment()` -- optional polling of service task states
7. `pruneVariables()` -- remove unused configs/secrets

**Key modules**:

- `settings.ts` -- parses GitHub Actions inputs; merges variables
  from env, `variables`, `secrets`, and `extra-variables` inputs
- `variables.ts` -- config/secret management: hash-based rotation,
  file/env/content sources, base64/hex transforms, pruning
- `engine.ts` -- Docker CLI wrapper: stack deploy, compose config,
  service/secret/config listing, task listing
- `compose.ts` -- compose file resolution, YAML loading,
  normalization, interpolation engine
- `monitoring.ts` -- polls service tasks until convergence or
  timeout, with structured failure diagnostics and early failure
  detection via `isServiceStuck()`
- `main.ts` -- entry point: calls `deploy()`, sets action outputs,
  uploads compose spec artifact

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

Three workflows run on push to main: `ci.yml` (tests),
`linter.yml` (super-linter), `licensed.yml` (license compliance).

Super-linter excludes `dist/`, `docs/superpowers/`, and
`.licenses/` directories. Markdown files must follow the config in
`.github/linters/.markdown-lint.yml` (80 char line length, tables
exempt).

`release.yml` triggers on semver tags (`v*.*.*`), updates rolling
`vN` and `vN.N` tags, and creates a GitHub release.

## Tooling

- **Biome** for linting and formatting (not ESLint/Prettier)
- **Vitest** for testing with V8 coverage
- **@vercel/ncc** bundles TypeScript source into a single ESM file
- TypeScript strict mode, ESNext target, bundler module resolution

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
