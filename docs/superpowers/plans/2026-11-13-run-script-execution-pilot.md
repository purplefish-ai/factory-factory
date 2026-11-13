# Run-Script Execution Pilot Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this
> plan task by task, with a final independent code review.

**Goal:** Encapsulate one run-script attempt and prove its ownership across
asynchronous startup, stop, exit and auxiliary cleanup.

**Architecture:** Keep workspace-lived coordination, output channels and public
APIs in RunScriptService. Move per-attempt process ownership and lifecycle into
RunScriptExecution. Preserve the persisted state machine and workspace writer.

**Tech Stack:** TypeScript, Node 26.12.1, pnpm 12.15.0, Vitest, Prisma/SQLite.

**Spec:**
`docs/superpowers/specs/2026-11-13-run-script-execution-model-design.md`

## Global Constraints

- Keep public service APIs, persisted statuses, orphan recovery and output
  subscriptions stable. No schema changes or frontend testing changes.
- Preserve cleanup command reconciliation and existing timeout/retry policy.
- Reproduce ownership bugs before changing behavior; scope fixes to local
  attempt ownership, without claiming cross-process durable fencing.
- Existing isolated worktree and branch are the implementation workspace.
- User authorized implementation and PR creation; execute inline through
  delivery without another plan approval checkpoint.

## Review Focus

- Stop during pre-spawn work must prevent that attempt from spawning later.
- Old exit or cleanup continuations must not remove a replacement's resources.
- Stop intent must prevent postRun even while user cleanup is pending.
- Fast exits and persistence failures must retain their existing outcomes.
- Output subscriptions and restart PID recovery must survive the extraction.

### Task 1: Characterize asynchronous ownership

**Files:** Add a focused public-API ownership test suite beside
RunScriptService.

**Interfaces:** Exercise startRunScript/stopRunScript with controlled child
events, deferred port/tunnel completion and a status-changing persistence fake.

- [x] Add tests for stop during port allocation, exit during user cleanup and
      late tunnel completion/replacement. Preserve existing exit-persistence
      tests.
- [x] Run the new tests and record observed failures before implementation.
- [x] Record the demonstrated gaps in the design and implementation ledger.

### Task 2: Extract execution ownership and fix reproduced gaps

**Files:** Create run-script-execution.ts; modify run-script.service.ts and, if
the tunnel experiment requires it, run-script-proxy.service.ts.

**Interfaces:** RunScriptExecution owns a preparing/live/ended observation, stop
intent, main/postRun processes and their effects. The service retains a
workspace-to-current-execution index and workspace output channels. Pass narrow
ownership/output capabilities rather than the coordinating service itself.

- [x] Add focused tests for execution transitions before the implementation.
- [x] Move process lifetime operations behind execution methods and preserve
      existing retry, timeout and durable-status behavior.
- [x] Fence demonstrated stale continuations and prevent auxiliary startup as
      soon as explicit stop admission succeeds.
- [x] Run all run-script suites and typecheck; fix contract regressions.
- [x] Commit the production extraction and demonstrated race fixes separately
      where the intermediate state is independently verifiable.

### Task 3: Clean up legacy suites and deliver

**Files:** Split run-script.service.test.ts by lifecycle behavior, with a small
test-support module; update workspace-state.md and file-length baselines.

**Interfaces:** Test helpers belong only in test support. Preserve existing
assertions, migrate private-map setup to domain operations where practical, and
keep each suite below the normal file-length cap.

- [x] Split startup/exit, stop, auxiliary/output and shutdown tests.
- [x] Update documentation with implemented ownership and observed limitations.
- [x] Run final check:fix, typecheck, the full test suite and check. Work around
      the sandbox's tsx IPC restriction through direct Node invocation if
      necessary.
- [x] Request independent review, fix material findings and rerun affected
      checks. Inspect the final diff and exclude unrelated formatter changes.
      Delivery: commit, push this branch and create a non-draft PR using a body
      file.

## Execution Record

- Planning: user-approved domain model; implementation authorized in chat.
- Delivery preflight: GitHub authentication works outside the network sandbox.
- Characterization: failed tests demonstrated pre-spawn, admission publication,
  stop/postRun, replacement reconciliation and stale tunnel ownership gaps.
- Review: independent review identified the admission publication and cancelled
  admission cleanup edges; both gained failing regressions and fixes.
- Focused verification: all 284 run-script tests pass; original 101 legacy tests
  preserved across seven suites.
- Final verification: full suite 1,380 files and 15,901 tests passed, with four
  skipped files, 14 skipped tests and one expected failure. check:fix,
  typecheck, check and the production build passed. Existing Biome schema and
  literal-test-string warnings remain unchanged.
