# Vite and Vitest Upgrade Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Vite, its React plugin, Vitest, coverage-v8, and jsdom together without changing application behavior.

**Architecture:** Keep the existing Vite, Storybook, and test configuration unless migration evidence requires a change. Migrate the chat grouping benchmark to Vitest 5's test-context API.

**Tech Stack:** Node 26.8.1, pnpm 12.3.4, Vite 8.2.2, React plugin 6.1.1, Vitest/coverage-v8 5.0.0, jsdom 30.0.1.

**Spec:** User-approved dependency upgrade sequence; this PR follows merged #2247 and must merge before the next group starts.

## Constraints

- Keep existing test assertions and coverage thresholds.
- Keep the TypeScript 7 compiler / TypeScript 6 API aliases.
- Use pnpm and normal commit hooks. Do not merge the PR.

## Task 1: Upgrade and migrate

**Files:** `package.json`, `pnpm-lock.yaml`, `src/client/features/chat/incremental-chat-grouping.bench.ts`; configuration or affected tests only if validation demonstrates a migration requirement.

- [x] Establish baseline: frozen install and 5,455 tests pass; all three mobile tests reach screenshot comparison and fail existing golden comparisons. Preserve their actual images outside the repo for comparison.
- [x] Run `pnpm add -D vite@^8.2.2 @vitejs/plugin-react@^6.1.1 vitest@^5.0.0 @vitest/coverage-v8@^5.0.0 jsdom@^30.0.1` and inspect peer warnings and lockfile changes.
- [x] Run `pnpm typecheck` and the test suite to identify concrete migration failures.
- [x] Replace the benchmark's top-level `bench` import with `test`, then execute both existing operations via `await bench.compare(bench('pure full regroup', ...), bench('incremental tail regroup', ...))` inside `test(..., async ({ bench }) => ...)`. Preserve the prewarmed incremental grouper and changing tail inputs.
- [x] Run `pnpm exec vitest bench --run incremental-chat-grouping`.

## Task 2: Validate and submit

- [x] Run `pnpm check:fix`, `pnpm typecheck`, `GIT_TRACE2_EVENT=0 pnpm test:coverage`, and strict `pnpm check` with the pinned Codex CLI on PATH.
- [x] Run `pnpm build` and `pnpm build:storybook`.
- [x] Run mobile browser tests and compare current actual screenshots against pre-upgrade actuals; do not replace repository goldens to hide baseline failures. Check development HMR and production asset loading.
- [x] Review the diff, address findings, and verify the final changes. Added the Unreleased changelog entry requested during review; no code findings.
Submission: commit through normal hooks and open one PR after review; the user merges it before the next upgrade.

## Validation results

- Fresh frozen install, typecheck, Biome, strict guardrails, Knip, and audit pass (no known vulnerabilities).
- Full tests and coverage: 5,455 passed, 4 skipped. Coverage: 86.96% lines, 86.97% statements, 87.42% functions, 77.70% branches; critical coverage checks pass unchanged.
- Chat grouping benchmark passes via `pnpm exec vitest bench --run incremental-chat-grouping`. Vitest warns about module export getter overhead; benchmark timings are diagnostic, not a performance claim.
- Production and Storybook builds pass. Development React Fast Refresh updates a component without reloading; the production page executes with 30 successful asset responses and no JavaScript errors.
- All three mobile interaction/layout checks pass before screenshot comparison. The checked-in goldens already fail on base commit `63a7434a`; pre-upgrade and post-upgrade actual images are pixel-identical for iPhone SE, iPhone 14, and Pixel 7. Golden files are unchanged.
- Vite and Vitest aliases now use `import.meta.dirname`, removing Vite 8's native config-loader compatibility warning.
- Linux ARM64/Alpine Docker builder and built CLI help smoke pass.

## Migration references

- [Vite 8 migration guide](https://vite.dev/guide/migration)
- [Vitest 5 migration guide](https://vitest.dev/guide/migration/)
- [Vitest benchmarking API](https://vitest.dev/guide/benchmarking)
- [jsdom 30 release notes](https://github.com/jsdom/jsdom/releases/tag/v30.0.0)
