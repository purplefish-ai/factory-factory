# Task Creation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preserve task drafts and make failed workspace setup discoverable and
recoverable without changing successful creation navigation.

**Architecture:** The kanban feature owns a versioned per-project browser draft
and its storage lifecycle. Session selection owns serialization of launch
choices. Existing workspace persistence, status projections, and retry controls
remain the authority after creation; trace and repair failures in that path with
regressions.

**Tech Stack:** TypeScript, React, IndexedDB, Zod, tRPC, Vitest, Storybook; Node
26.12.1 and pnpm 12.15.0 as pinned in this checkout.

**Spec:**
[Approved behavior and design](../specs/2026-10-31-task-creation-recovery-design.md).

## Global Constraints

- Keep one creation draft per project.
- Keep the current successful creation flow without automatic navigation.
- Closing the composer preserves its draft; Discard draft removes it explicitly.
- Submission errors preserve the editable draft and appear inline.
- Retry setup operates on the same workspace and preserves its initial task.
- Follow feature barrels, service ownership, Zod validation, and CONTRIBUTING.
- No named-draft manager, cross-device sync, or automatic setup retry.

## Review Focus

- Immediate navigation/refresh must preserve the last edit and attachment write.
- A late create response must not erase a newer draft or another project's
  draft.
- Delayed settings hydration must not replace restored explicit launch choices.
- Storage errors or malformed records must preserve usable input and explain
  loss.
- A failed setup before any session starts must remain visible and be manually
  retryable on the same workspace.

## Task 1: Persist and restore project creation drafts

**Files:**

- Create `src/client/features/kanban/workspace-creation-draft-storage.ts` and
  test.
- Create `src/client/features/kanban/use-workspace-creation-draft.ts` and test.
- Modify `src/client/features/session-selection/use-session-launch-selection.ts`
  and its co-located tests; export intentional public types from `index.ts`.
- Modify `src/client/features/kanban/inline-workspace-form.tsx` and its test.
- Modify `src/client/features/kanban/kanban-board.tsx` and its test.

**Interfaces:**

Storage exposes `loadWorkspaceCreationDraft(projectId)`,
`saveWorkspaceCreationDraft(projectId, draft)`, and
`clearWorkspaceCreationDraft(projectId, expectedRevision)` as promises. Drafts
contain a schema version, revision, prompt, attachments, ratchet setting, launch
selection, mode, cadence, and scheduled time. Use existing attachment and launch
schemas/types; define the versioned draft schema in the storage file. The hook
exposes `draft`, `updateDraft`, `isRestoring`, `persistenceError`, and
`clearSubmittedDraft(revision)`; revision-checked clearing is transactional.
Session selection exposes a typed serializable snapshot and a restoration option
without leaking private state through cross-feature imports.

- [ ] Add failing tests for remount and refresh restoration, project isolation,
      closing versus discard, attachment round-trip, and malformed storage.
- [ ] Add failing tests for immediate navigation after edits,
      blocked/quota-failed storage, serialized writes, and late old saves after
      clear. Assert visible persistence errors and that usable in-memory input
      remains intact. Bound IndexedDB opening, retain immediate read-your-writes
      across remounts, and test storage in installed Chromium without a new
      dependency.
- [ ] Add launch-selection regressions for delayed settings and project
      switches; preserve provider-specific choices, including null reasoning
      defaults.
- [ ] Run focused tests and confirm failures reflect missing behavior.
- [ ] Implement versioned IndexedDB storage with Zod validation, ordered writes,
      revision-checked clear, and no new dependency. Enqueue saves on changes;
      do not depend on an unmount callback starting an asynchronous save.
- [ ] Integrate the hook and session-selection restoration. Disable submission
      during draft hydration, preserve async attachment updates in their
      original project, and restore textarea height. Show a resume affordance
      when the composer is closed; preserve explicit close rather than reopening
      it on every board rerender. Add Discard draft without treating Cancel as
      discard.
- [ ] Run the focused tests, verify clean project switching, and commit Task 1.

## Task 2: Preserve submissions and show errors beside the draft

**Files:**

- Modify `src/client/features/kanban/inline-workspace-form.tsx` and its test.
- Update `src/client/features/kanban/inline-workspace-form.stories.tsx`.

**Interfaces:** Consume Task 1's hook and revision-checked clear; keep existing
`onCreated(workspaceId)` and `onCancel()` contracts and optimistic row rollback.

- [ ] Add failing tests that request rejection retains prompt, attachments,
      launch choices, and an accessible inline error. A subsequent submission
      must send those retained values and clear the error at the start of that
      attempt.
- [ ] Add tests for successful creation clearing only its submitted revision,
      including unmount/remount while the request is pending and a newer draft
      created before the old response. Test periodic-agent success separately.
      Assert late success cannot close a newer or different-project composer;
      retain pending state across remounts to prevent duplicate submissions.
- [ ] Run the tests to confirm failure, then implement inline mutation errors
      and success cleanup. Keep normal creation navigation and existing mobile
      column switching. Capture the submitted project's ID and draft revision
      explicitly.
- [ ] Run focused tests; add stories for restored draft, request rejection, and
      persistence warning. Commit Task 2.

## Task 3: Keep setup failures visible and recover in the workspace

**Files to inspect and test:**

- `src/client/features/kanban/kanban-card.tsx`, its test and stories.
- `src/client/features/kanban/kanban-context.tsx` and its test.
- `src/client/features/kanban/kanban-board.tsx` and its test.
- `src/client/lib/workspace-summary.ts` and cache helpers.
- `src/client/hooks/use-project-snapshot-sync.ts` and snapshot tests.
- `src/shared/kanban-column-projection.test.ts`.
- `src/backend/services/workspace/service/query/workspace-summary-projector.test.ts`.
- `src/backend/orchestration/workspace-init-startup-order.test.ts`.
- `src/backend/trpc/workspace/init.retry-state-machine.test.ts`.
- `src/client/routes/projects/workspaces/workspace-detail-chat-content.test.tsx`.
- `src/client/features/workspace/workspace-content-view.tsx` and its test.

**Interfaces:** Preserve `SETUP_FAILED -> WAITING`, shared workspace summary
IDs, `workspace.retryInit({ id })`, and persisted creation metadata. Reuse
existing workspace-level failure and retry views rather than adding a board
retry action.

- [ ] Trace create response, optimistic replacement, snapshot publication,
      failed initialization, list refresh, and board filtering. Write a
      regression for NEW -> PROVISIONING -> FAILED before an agent starts,
      including a snapshot arriving before the create response. Assert one real
      workspace remains visible in Waiting after refresh and navigation. Record
      the cause if found; do not claim the reported disappearance is reproduced
      without evidence.
- [ ] Read the backend service guide before backend changes. Fix any reproduced
      retention/cache defect at its owning layer; preserve unrelated workspaces
      and concurrent cache updates. If no defect reproduces, retain the tests
      and report that limit instead of adding speculative lifecycle changes.
- [ ] Add a regression that a setup-failed card has an accessible error icon and
      Setup failed explanation and still opens the existing workspace. Reuse
      existing status badge where adequate, avoiding duplicate warning icons.
      The existing FAILED WorkspaceStatusBadge supplies icon, label, and
      tooltip; test Working-to-Waiting mobile visibility too.
- [ ] Verify the workspace error view works without a worktree or session. Add
      tests for retrying the same ID and retaining instructions plus
      attachments; extend the initial-task test to assert one delivery after
      failed setup and retry. Preserve intentional cancellation behavior. Add
      route-owned setup failure/retry presentation to WorkspaceContentView's
      sessionless empty state; test FAILED plus no worktree plus no sessions.
- [ ] Run focused tests and update failed/retrying card and workspace stories.
      Commit Task 3.

## Task 4: Verify the complete flow and document behavior

**Files:** Update `docs/architecture/workspace-state.md`; implementation and
test files above only as needed to resolve verification findings.

- [ ] Document browser-local per-project drafts, close/discard semantics,
      storage failure behavior, and workspace-level setup recovery.
- [ ] Run `pnpm check:fix`, inspect its diff, and discard unrelated formatting.
- [ ] Run `pnpm typecheck`, `pnpm test`, and `pnpm check` using pinned versions.
      Run `pnpm test:integration` if backend integration behavior changed.
- [ ] Run `pnpm storybook` and inspect restored drafts, request errors, failed
      setup cards, and workspace retry on desktop and mobile. Run
      `pnpm test:e2e:mobile` if mobile behavior changes.
- [ ] Review the final diff against the design, validate documentation links,
      report unavailable checks and unreproduced issues, and commit the final
      documentation/verification changes.
