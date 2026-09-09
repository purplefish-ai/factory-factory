# Development Tooling Upgrade Plan

> **For agentic workers:** Use superpowers:executing-plans to implement and verify the grouped upgrade.

**Goal:** Use TypeScript 7.0.2 for compilation and typechecking, and update compatible development tools in one PR.

**Architecture:** Follow Microsoft's supported side-by-side configuration: `@typescript/native` aliases `typescript@^7.0.2` and owns `tsc`; `typescript` aliases `@typescript/typescript6@^6.0.2` and preserves the compiler API consumed by guardrails and third-party tools. Group dependency-cruiser 18.2.0, lint-staged 17.5.0, concurrently 10.0.5, and @types/supertest 7.2.1 if validation requires no application behavior changes.

**Tech Stack:** Node 26.8.1, pnpm 12.3.4, TypeScript 7 CLI / 6 compiler API, Vitest 4.

**Spec:** User-approved upgrade queue; user now permits grouping straightforward dependency updates. Sources: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ and each tool's official migration/release notes.

## Constraints

- Base the PR on merged #2234; do not start a second upgrade PR until this one merges.
- Preserve strict compiler checks and guardrail coverage. Do not weaken assertions or introduce broad type casts.
- Keep Vite/Vitest, runtime libraries, and Electron upgrades for subsequent PRs.
- Use pnpm and run normal commit hooks.

## Task 1: Dependency and compiler migration

**Files:** `package.json`, `pnpm-lock.yaml`, `tsconfig.json` only if compiler defaults require explicit compatibility settings.

- [x] Install the frozen baseline and verify current package versions and upstream major-version migration requirements.
- [x] Run the baseline typecheck.
- [x] Run `pnpm add -D '@typescript/native@npm:typescript@^7.0.2' 'typescript@npm:@typescript/typescript6@^6.0.2' dependency-cruiser@^18.2.0 lint-staged@^17.5.0 concurrently@^10.0.5 @types/supertest@^7.2.1`.
- [x] Confirm `pnpm exec tsc --version` is 7.0.2, `tsc6 --version` is 6.0.3 (via compatibility package 6.0.2), and importing `typescript` still exposes `createSourceFile`.
- [x] Run typecheck and build to identify compiler diagnostics. Explicitly list required global type packages if the new empty `types` default needs it; preserve configured output roots and strictness.
- [x] Verify lockfile scope and frozen installation; investigate any unexpected transitive updates.

## Task 2: Documentation and validation

**Files:** `README.md`, `CHANGELOG.md`, this plan; existing tests only when required by a behavior fix.

- [x] Document the compiler/API split and lint-staged's Git >=2.32 requirement. Consolidate Unreleased dependency notes to describe the final versions.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, `GIT_TRACE2_EVENT=0 pnpm test`, strict `pnpm check`, `pnpm knip`, application and Storybook builds, and dependency audit.
- [ ] Smoke-test concurrent command execution and exit propagation. Normal commit hooks verify lint-staged against real staged changes.
- [x] Build Docker to validate the native compiler on Alpine, then smoke the compiled CLI and database migrations.
- [ ] Get a read-only code review, commit with normal hooks, and open a PR with the validation results.
- [ ] Wait for merge before the next upgrade group.

## Verification notes

- Baseline typecheck and 60 compiler-API guardrail tests passed.
- `tsc` reports 7.0.2; `tsc6` and imported compiler API report 6.0.3, supplied by compatibility package 6.0.2.
- TypeScript 7 typecheck and backend/frontend build passed without source or compiler-setting changes.
- dependency-cruiser 18 and Knip passed after the aliases and dependency updates.
- Lockfile package additions/removals are confined to these tooling packages and their dependencies; runtime dependency declarations are unchanged.
- Full suite: 5,441 passed, four manual skips. Typecheck, formatting, strict guardrails, application/Storybook builds, and Electron compilation passed; audit reported zero vulnerabilities.
- Concurrent CLI execution and failure propagation passed. Docker ARM64 image built with TypeScript 7.0.2, then CLI help and all database migrations passed.
- Read-only review clean. Normal commit hooks provide the final lint-staged 17 verification.
