# Task 6 Report

## Status

Complete.

## RED evidence

Added the requested readiness tests before production implementation. Running
`pnpm test src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`
failed as expected: 22 tests ran, 16 passed, and the 6 new cases failed with
`TypeError: isProviderSubagentSessionReady is not a function`.

## Implementation summary

- Added `ProviderSubagentSessionReadyOptions` and
  `isProviderSubagentSessionReady` to the workspace detail container utilities.
- Readiness now requires a selected session, matching hydrated runtime session,
  connected chat WebSocket, and an alive ACP process.
- Passed the predicate result to `WorkspaceDetailView` as `selectedSessionReady`.
- No ACP runtime initialization was added for passive page loads.

## Verification

- `pnpm test src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`
  — RED as described above.
- `pnpm test src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/client/features/subagents/provider-subagents-section.test.tsx`
  — PASS, 2 files / 33 tests.
- `pnpm test src/client/routes/projects/workspaces/workspace-detail-view.test.tsx src/client/features/workspace/agents-panel.test.tsx src/client/features/subagents/use-live-subagent-selection.test.tsx`
  — PASS, 3 files / 20 tests.
- `pnpm typecheck` — PASS.
- `pnpm check` — PASS. The local Codex schema check was skipped by the
  repository because installed codex-cli 0.147.0 differs from pinned 0.145.0.
- `git diff --check` — PASS.

## Commit

`02a67937979856a3b6a6668a509385cee0e6c09e`

## Self-review

The diff is limited to the specified utility, test, and container files. The
predicate is pure and uses the existing runtime state; the existing provider
subagent false-to-true invalidation path remains responsible for refetching.

## Concerns

None. The only verification caveat is the expected local Codex schema-check
skip due to the installed CLI version mismatch.
