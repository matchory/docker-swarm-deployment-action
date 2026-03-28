# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

GitHub Action for deploying Docker Swarm stacks with automatic config/secret management, variable rotation, and optional post-deployment monitoring. Written in TypeScript, runs on Node 24.

## Commands

| Task | Command |
|------|---------|
| Package (TS → dist/) | `npm run package` |
| Run tests | `npm run test` |
| Run single test | `npx vitest run tests/compose.test.ts` |
| Lint | `npm run lint` |
| Format check | `npm run format:check` |
| Format fix | `npm run format:write` |
| Full pipeline | `npm run all` |

The `dist/` directory is committed — run `npm run package` after source changes.

## Architecture

**Build chain**: `src/*.ts` → @vercel/ncc (`dist/index.js`)

**Deployment flow** (orchestrated in `deployment.ts`):
1. `resolveComposeFiles()` — find compose file(s) with auto-detection fallback
2. `loadComposeSpecs()` — parse YAML
3. `normalizeSpec()` — validate via `docker compose config`
4. `interpolateSpec()` — substitute `${VAR}` references
5. `deployStack()` — execute `docker stack deploy` with compose spec on stdin
6. `monitorDeployment()` — optional polling of service task states
7. `pruneVariables()` — remove unused configs/secrets

**Key modules**:
- `settings.ts` — parses GitHub Actions inputs; merges variables from env, `variables`, `secrets`, and `extra-variables` inputs with defined priority order
- `variables.ts` — core config/secret management: hash-based rotation (SHA256 appended to names), file/env/content sources, base64/hex transformations, pruning of stale entries
- `engine.ts` — Docker CLI wrapper: stack deploy, compose config, service/secret/config listing
- `compose.ts` — compose file resolution, YAML loading, normalization, interpolation engine
- `monitoring.ts` — polls service tasks until convergence or timeout
- `main.ts` — entry point: calls `deploy()`, sets action outputs, uploads compose spec artifact

## Tooling

- **Biome** for linting and formatting (not ESLint/Prettier)
- **Vitest** for testing with V8 coverage
- **@vercel/ncc** bundles TypeScript source directly into a single ESM file
- TypeScript strict mode, ESNext target, bundler module resolution
