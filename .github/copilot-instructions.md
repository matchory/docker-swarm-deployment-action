# Copilot Instructions for Docker Swarm Deployment Action

## Repository Overview

This is a **GitHub Action** written in **TypeScript** that deploys applications
to Docker Swarm clusters. The action automatically handles Docker Compose
specifications, manages secrets and configs, monitors deployments, and provides
extensive customization options. The project is medium-sized (~2,400 lines of
TypeScript code) with comprehensive test coverage (98%+) and follows GitHub
Action best practices.

**Key Features**: Automatic Compose file detection, secret/config rotation,
post-deployment monitoring, Docker context support, variable interpolation, and
extensive error handling.

**Target Runtime**: Node.js 20+  
**Main Languages**: TypeScript, YAML, Bash  
**Package Manager**: npm (v10.8.2+)  
**Key Dependencies**: @actions/core, @actions/exec, js-yaml  
**Build Tools**: unbuild, @vercel/ncc, vitest, biome

## Build and Validation Commands

**Environment is pre-initialized**: Dependencies are already installed and the
project is built via the `.github/workflows/copilot-setup-steps.yml` workflow.

### Available Commands (No Setup Required)

```bash
npm run build    # TypeScript compilation via unbuild → creates /out directory
npm run bundle   # Bundle for Action distribution → creates /dist directory
npm run package  # Combined build + bundle (shortcut for both above)
```

**Critical**: The `/dist` directory contains the final bundled Action code that
GitHub executes. Always run `npm run package` after code changes.

### Testing and Quality Checks

```bash
npm run test           # Run vitest test suite (takes ~2 seconds, expect 98%+ coverage)
npm run lint           # Biome checking (must pass)
npm run format:check   # Biome formatting check
npm run format:write   # Fix formatting issues automatically
```

**Common Issue**: `format:check` may fail if README.md has formatting issues.
Run `format:write` to fix.

### Complete Pipeline

```bash
npm run all  # Runs: format:write → lint → test → coverage → package
```

**Note**: The `coverage` step may fail due to network restrictions
(img.shields.io unavailable), but this doesn't affect functionality.

### Development Commands

```bash
npm run package:watch  # Watch mode for bundle rebuilding during development
npm run local-action   # Test action locally with .env file
```

## Project Architecture and Layout

### Core Source Files (`/src/`)

- **`main.ts`**: Entry point and orchestration logic - modify for new top-level
  features
- **`deployment.ts`**: Core deployment orchestration and Docker commands
- **`engine.ts`**: Docker engine interaction and command execution
- **`compose.ts`**: Docker Compose file parsing, validation, and manipulation
- **`variables.ts`**: Secret/config management, rotation, and pruning logic
- **`monitoring.ts`**: Post-deployment health checking and service monitoring
- **`settings.ts`**: Input parsing and configuration management
- **`utils.ts`**: Shared utilities (interpolation, file operations, etc.)
- **`types.d.ts`**: TypeScript type definitions
- **`index.ts`**: Simple entry point that calls main.ts

### Configuration Files (Root)

- **`action.yml`**: GitHub Action metadata and input/output definitions
- **`package.json`**: Node.js project configuration and script definitions
- **`tsconfig.json`**, **`tsconfig.base.json`**, **`tsconfig.node.json`**:
  TypeScript configuration
- **`biome.json`**: Biome code formatting and linting configuration
- **`build.config.ts`**: unbuild configuration for TypeScript compilation
- **`vitest.config.ts`**: Test runner configuration with coverage settings
- **`.node-version`**: Specifies Node.js 23.10.0 requirement

### Testing (`/tests/`)

All source files have corresponding `.test.ts` files with comprehensive
coverage:

- Tests use **vitest** framework with extensive mocking
- Coverage reports expect 98%+ coverage across all files
- Test files mirror the structure of `/src/` directory

### CI/CD Workflows (`.github/workflows/`)

- **`ci.yml`**: Main CI pipeline (test, lint, format check) - runs on PR/push to
  main
- **`linter.yml`**: Super-linter validation with specific exclusions for
  dist/\*\*, JSON, TypeScript ES
- **`codeql-analysis.yml`**: GitHub security analysis
- **`licensed.yml`**: License compliance checking with `.licensed.yml` config

### Build Outputs

- **`/out/`**: TypeScript compilation output (intermediate)
- **`/dist/`**: Final bundled action code (committed to repository, used by GitHub)
- **`/coverage/`**: Test coverage reports
- **`/badges/`**: Coverage badges (SVG files)

## Critical Development Notes

### GitHub Action Distribution

- The `/dist/` directory **MUST** be committed after code changes
- GitHub Actions run from `dist/index.cjs` (not source code)
- Use `npm run package` to update `/dist/` after modifications

### Environment Variables and Secrets

- Action reads configuration from `process.env` (GitHub Action inputs)
- Supports complex variable interpolation with compose-spec syntax
- Test files extensively mock environment variables

### Docker Dependencies

- Action requires Docker daemon access in runtime environment
- Uses `docker` CLI commands via @actions/exec
- Supports SSH, TCP, and Unix socket connections via DOCKER_HOST

### Error Handling Patterns

- Extensive error handling throughout codebase
- Uses @actions/core for GitHub Actions logging and error reporting
- Monitor logs for deployment failures in post-deployment monitoring

### Common Development Issues

1. **Format check failures**: Run `npm run format:write` before committing
2. **Missing dist updates**: Always run `npm run package` after code changes
3. **Test environment**: Tests mock Docker commands - no real Docker required
   for testing
4. **Network dependencies**: Some scripts (coverage badges) may fail in
   restricted environments
5. **Pre-initialized environment**: Dependencies and build are already prepared
   via copilot-setup-steps.yml workflow

### Key Dependencies to Avoid Updating Carelessly

- `@actions/*` packages: Core GitHub Actions functionality
- `js-yaml`: Critical for Compose file parsing
- Build tools (unbuild, @vercel/ncc): Changes may affect action bundling

### Files to Modify Based on Task Type

- **New Action Inputs**: `action.yml` + `src/settings.ts`
- **Docker Operations**: `src/engine.ts` + `src/deployment.ts`
- **Compose Handling**: `src/compose.ts` + `src/variables.ts`
- **Monitoring Logic**: `src/monitoring.ts`
- **Bugfixes**: Corresponding source file + add/update tests
- **Documentation**: `README.md` (autoformatted by biome)

**Trust these instructions** - they are based on comprehensive repository
analysis and successful command execution. Only explore further if the provided
information is insufficient or incorrect.
