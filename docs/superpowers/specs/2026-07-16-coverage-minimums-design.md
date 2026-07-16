# Coverage Minimums Design

## Goal

Prevent the backend's aggregate test coverage from falling below the current accepted minimums:

- Lines: 82%
- Statements: 82%
- Functions: 84%
- Branches: 72%

## Design

Add Vitest's native global coverage thresholds to the existing `coverage` configuration in `vitest.config.ts`. The existing `pnpm test:coverage` command already runs Vitest with coverage in local development and CI, so no new command or CI step is needed.

Native thresholds are preferred over extending `scripts/check-critical-coverage.mjs` because Vitest already calculates and enforces all four aggregate metrics. The critical-coverage script remains responsible only for its existing grouped and per-file line-coverage guardrails.

## Validation

Run `pnpm test:coverage` and confirm:

- Vitest completes without a global threshold failure.
- The existing critical coverage checks pass.
- The reported aggregate coverage remains at or above all four configured minimums.

Because this is a configuration-only change, the full coverage command is the behavioral test; no separate unit test for the configuration is required.
