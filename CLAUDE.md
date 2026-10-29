# CLAUDE.md

- `dist/` is committed and is what the runner executes. After changing `src/`, run `npm run package` and commit
  `dist/` with the change; `check-dist.yml` fails otherwise. `npm run all` runs the whole pipeline.
- A dependency bump alone makes `check-dist.yml` and `licensed.yml` fail. That is expected:
  `regenerate-artifacts.yml` rebuilds `dist/` and `.licenses/` after merge to main and opens a PR.
- TypeScript is version 7 (native compiler) and is only a typechecker. It has no JavaScript API, so do not add any
  tool that loads the `typescript` package (this is why ncc was dropped).
- Every process environment variable becomes a deployment variable. Tests that run the action must pass a minimal
  environment.
- Fail through `core.setFailed` rather than letting an exception escape: Node prints the raw bundled line above the
  stack, which floods the Actions log.
- `npm run test:swarm` deploys to whatever the current Docker context points at, and needs `dist/` built first.
- Property tests (`tests/properties`) need Docker but no swarm. `PROPERTY_RUNS=1000 npm run test` runs more cases.
  When a bug is found outside the grammar in `arbitraries.ts`, extend the grammar and keep the shrunk
  counterexample as a unit test.
