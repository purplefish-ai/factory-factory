# Bundled Claude Runtime Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this
> plan in the existing isolated worktree.

**Goal:** Use the Claude runtime shipped with ACP for CLI access, health,
authentication instructions, and model discovery.

**Architecture:** Keep upstream Claude ACP and its matched Agent SDK. Mirror the
existing Codex CLI passthrough using upstream `--cli`, and share the ACP
Node/Electron launcher with model discovery. Runtime updates ship with the app.

**Tech Stack:** TypeScript, Commander, ACP, Vitest, React, Electron.

**Accepted requirements:**

- Expose the bundled Claude CLI for authentication and native commands.
- Probe the same runtime for health and authentication; ship updates with the
  app.
- Share the Node/Electron-safe launch path with model catalog discovery.
- Verify packaged runtimes without global Claude or Node installations.

## Constraints and review focus

- Preserve native CLI arguments, exit codes, signals, and environment overrides.
- Missing bundled runtimes must recommend app repair, never global installation.
- Health must probe the same runtime as sessions and avoid registry freshness.
- Catalog discovery must work without a global Node executable, outside ASAR.
- Keep Codex account selection and warning dismissal behavior intact.
- Verify packaged runtimes without global Claude/Node; report unavailable OS
  validation explicitly.

## Task 1: Managed CLI and health

- [x] Add failing tests for Claude native argument passthrough,
      exit/signal/error handling, Electron path resolution, health/auth parsing,
      missing runtimes, and rejection of global upgrades.
- [x] Add `getBundledClaudeCommand(args)` and `ff claude`, using upstream
      `--cli` and `ELECTRON_RUN_AS_NODE=1`.
- [x] Switch Claude health to the managed command; retain the upgrade endpoint
      as a compatibility rejection for both managed providers.
- [x] Run focused CLI and health tests.

## Task 2: Catalog and setup consistency

- [x] Add a failing catalog regression for Node/Electron startup and ASAR paths.
- [x] Use `resolveProviderAcpSpawnCommand('CLAUDE')` for model discovery.
- [x] Replace global Claude instructions with `ff claude auth login`; show app
      repair for missing runtimes and remove obsolete update controls.
- [x] Update component tests and stories, runtime/setup documentation, and
      Docker setup so no global Claude install is required.
- [x] Run focused tests and check changed Storybook states.

## Task 3: Verification and delivery

- [x] Add/run packaged-runtime smoke checks with a restricted PATH, including
      Claude version and the actual ACP catalog loader without inference.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`,
      `pnpm test:integration`, and `pnpm check`; inspect all diffs.
- [x] Review the final change and prepare a ready-for-review PR description with
      validation evidence and platform limitations.

Delivery: commit, push the task branch, and create the requested PR.

## Execution record

- Existing linked worktree and task branch verified; no new worktree needed.
- Review ruling: add managed provider login buttons to the setup terminal; fresh
  desktop installs have no global `ff` command. Native PTY launches avoid shell
  quoting and share the app runtime with sessions.
- User authorized implementing all investigation recommendations and creating
  the PR; proceed without a second design approval.

- Full suite: 9,160 passed, 3 skipped (`pnpm test --maxWorkers=4`). Initial
  default-worker execution overlapped ongoing edits and hit two timing failures;
  the final stable run passed without weakening assertions.
- Integration suite: 219 passed, 3 skipped. Typecheck and repository checks
  pass.
- Playwright verified Claude sign-in, missing-runtime repair, and managed login
  actions in Storybook. A read-only follow-up review found no remaining major
  issues, pending packaged smoke verification.
- Packaging ruling: unpack complete production dependencies after the first
  actual macOS smoke reproduced missing `diff` from the external ACP process.

- Final unsigned macOS arm64 package smoke passed with Electron 45: Claude Code
  2.1.310 and five models from the actual ACP catalog loader, with an empty
  PATH. Native module rebuilding was disabled for this provider-only artifact
  check; Windows/Linux installers and interactive OAuth were not exercised
  locally.

- PR upkeep rebased the change onto `47eea7d94`, preserving the workspace-form
  changes and adapting global-updater regressions to the managed-runtime flow.
- Review fixes share CLI lifecycle code, bound process-tree termination, own
  native Windows commands, correlate login exits, block duplicate login starts,
  display server failures, and make authentication-only smoke validation opt-in.
- Retain strict managed entrypoint resolution instead of depending on session
  capsule internals or its PATH fallback. Retain complete production dependency
  unpacking because the backend also executes outside ASAR.

- Final follow-up verification: 9,186 tests passed (3 skipped), 219 integration
  tests passed (3 skipped), typecheck/check passed, and strict packaged catalog
  smoke returned five models. A real process-tree regression and Storybook login
  busy/error/stale-exit scenarios passed. The earlier unrelated benchmark
  startup timeout did not recur in the final two-worker suite.

- Follow-up review fixes forward terminal resizes, clean abnormal launcher
  exits, and kill the fixture process group if startup fails. Successful native
  commands retain their background-job semantics rather than applying
  disposable-probe cleanup to successful interactive CLI invocations.
- Desktop sign-in copy now leads with the setup terminal buttons and labels
  typed `ff` commands as requiring an installed CLI.
- A later local full-suite rerun hit multiple subprocess startup timeouts under
  machine load. Focused follow-up tests and the real shutdown regression passed;
  the pushed resize revision passed both CI shards, coverage, builds, repository
  checks, CodeQL, and Docker validation. Fixture startup now has its own
  allowance while shutdown still asserts completion within six seconds.
