# Copilot Instructions for Docker Swarm Deployment Action

## Repository Overview

This is a **GitHub Action** written in **TypeScript** that deploys applications
to Docker Swarm clusters. The action automatically handles Docker Compose
specifications, manages secrets and configs, monitors deployments, and provides
extensive customization options. The project is medium-sized (~6,000 lines of
TypeScript source) with high test coverage and follows GitHub Action best
practices.

`CLAUDE.md` in the repository root describes the architecture, CI, and known
pitfalls in more detail. Read it before larger changes.

**Key Features**: Automatic Compose file detection, Compose-Spec-to-Swarm
reconciliation, secret/config rotation, Compose profiles, settings in the
Compose file, post-deployment monitoring with failure diagnostics, and stack
removal.

**Target Runtime**: Node.js 24 (`runs.using: node24`, `.node-version`)  
**Main Languages**: TypeScript, YAML  
**Package Manager**: npm  
**Key Dependencies**: @actions/core, @actions/exec, @actions/artifact, js-yaml  
**Build Tools**: esbuild, vitest, biome, TypeScript 7 (typechecking only)

## Build and Validation Commands

**Environment is pre-initialized**: Dependencies are already installed via the
`.github/workflows/copilot-setup-steps.yml` workflow.

### Bundling

```bash
npm run package  # esbuild bundle (script/bundle.mjs) → dist/
```

**Critical**: The `dist/` directory contains the bundled Action code that
GitHub executes, and it is committed. Always run `npm run package` after code
changes.

### Testing and Quality Checks

```bash
npm run test           # Vitest unit, integration, and property tests, with coverage
npm run test:swarm     # Scenarios against a real swarm (needs Docker and dist/)
npm run typecheck      # tsc --noEmit
npm run lint           # Biome lint (must pass)
npm run format:check   # Biome formatting check
npm run format:write   # Fix formatting issues automatically
```

### Complete Pipeline

```bash
npm run all  # format:write → lint → typecheck → test → coverage → package
```

**Note**: The `coverage` step (coverage badge) may fail due to network
restrictions, but this doesn't affect functionality.

### Development Commands

```bash
npm run local-action   # Run the action locally with a .env file (see .env.example)
```

## Project Architecture and Layout

### Core Source Files (`src/`)

- **`index.ts`**: Entry point that calls `run()` in `main.ts`
- **`main.ts`**: Calls `deploy()` or `destroy()`, sets outputs, uploads the
  compose spec artifact
- **`deployment.ts`**: Orchestrates the deployment steps
- **`settings.ts`**: Input parsing, variable merging, stack settings
- **`compose.ts`**: Compose file detection, loading, merging, normalization,
  and interpolation of the spec
- **`reconcile.ts`**: Translates or strips Compose features Swarm lacks
- **`profiles.ts`**, **`env-file.ts`**, **`override-tags.ts`**: Compose
  profiles, `env_file` inlining, `!reset`/`!override` tags
- **`variables.ts`**: Secret/config management, rotation, and pruning
- **`labels.ts`**: Per-service settings labels and deployment labels
- **`healthcheck.ts`**: Health check warnings and report details
- **`shares.ts`**: Rejects volumes naming another stack's shared storage
- **`teardown.ts`**: Stack removal for the `destroy` input
- **`monitoring.ts`**: Post-deployment monitoring and failure reports
- **`engine.ts`**: Docker CLI wrapper
- **`utils.ts`**: Shared utilities, including the interpolation engine

### Configuration Files (Root)

- **`action.yml`**: GitHub Action metadata and input/output definitions
- **`package.json`**: Node.js project configuration and script definitions
- **`tsconfig.json`**, **`tsconfig.base.json`**, **`tsconfig.node.json`**:
  TypeScript configuration
- **`biome.json`**: Biome code formatting and linting configuration
- **`script/bundle.mjs`**: esbuild bundler that writes `dist/`
- **`vitest.config.ts`**, **`vitest.swarm.config.ts`**: Test runner
  configuration for the unit tests and the swarm scenarios
- **`.node-version`**: Node.js version used in CI

### Testing (`tests/`)

- Tests use **vitest** with extensive mocking of the Docker CLI
- Most source files have a corresponding `.test.ts` file;
  `*.integration.test.ts` files cover several modules together
- `tests/swarm/` runs the bundled action against a real single-node swarm
- `tests/properties/` compares generated Compose files against Docker's own
  processing; these need Docker, but no swarm

### CI/CD Workflows (`.github/workflows/`)

- **`ci.yml`**: Tests
- **`linter.yml`**: Super-linter, excluding `dist/`, `docs/superpowers/`, and
  `.licenses/`
- **`check-dist.yml`**: Fails if the committed `dist/` is out of date
- **`swarm.yml`**: Swarm scenarios, when runtime files change
- **`properties.yml`**: Property tests with many random cases, run by hand
- **`codeql-analysis.yml`**: GitHub security analysis
- **`licensed.yml`**: License compliance checking with `.licensed.yml` config
- **`regenerate-artifacts.yml`**: Regenerates `dist/` and `.licenses/` after
  dependency changes on main
- **`release.yml`**: Updates the rolling major/minor tags for a release tag

### Build Outputs

- **`dist/`**: Bundled action code (committed to repository, used by GitHub)
- **`coverage/`**: Test coverage reports
- **`badges/`**: Coverage badge (SVG)

## Critical Development Notes

### GitHub Action Distribution

- The `dist/` directory **MUST** be committed after code changes
- GitHub Actions run `dist/index.js`, which loads the bundle in `dist/main.js`
- Use `npm run package` to update `dist/` after modifications

### Environment Variables and Secrets

- Action reads its inputs from `INPUT_*` environment variables via @actions/core
- Every process environment variable also becomes a deployment variable
- Supports Compose-spec variable interpolation
- Test files extensively mock environment variables

### Docker Dependencies

- Action requires Docker daemon access in runtime environment
- Uses `docker` CLI commands via @actions/exec
- Connects wherever the Docker CLI does: `DOCKER_HOST`, `DOCKER_CONTEXT`, or
  the current context

### Error Handling Patterns

- Uses @actions/core for GitHub Actions logging and error reporting
- Fail through `core.setFailed` rather than letting an exception escape
- Monitoring writes failure reports to the log and the job summary

### Common Development Issues

1. **Format check failures**: Run `npm run format:write` before committing
2. **Missing dist updates**: Always run `npm run package` after code changes
3. **Test environment**: Unit tests mock Docker commands; the property tests
   need Docker, and only `npm run test:swarm` needs a real swarm
4. **Network dependencies**: The coverage badge script may fail in restricted
   environments
5. **Out-of-sync lockfile**: After changing dependencies, run `npm install`;
   `npm ci` and `npm run package` fail otherwise

### Key Dependencies to Avoid Updating Carelessly

- `@actions/*` packages: Core GitHub Actions functionality
- `js-yaml`: Critical for Compose file parsing
- Build tools (esbuild): Changes may affect action bundling

### Files to Modify Based on Task Type

- **New Action Inputs**: `action.yml` + `src/settings.ts` + `README.md`
- **Docker Operations**: `src/engine.ts` + `src/deployment.ts`
- **Compose Handling**: `src/compose.ts`, `src/reconcile.ts`,
  `src/variables.ts`
- **Monitoring Logic**: `src/monitoring.ts`
- **Bugfixes**: Corresponding source file + add/update tests
- **Documentation**: `README.md`

**Trust these instructions** - they are based on comprehensive repository
analysis and successful command execution. Only explore further if the provided
information is insufficient or incorrect.
