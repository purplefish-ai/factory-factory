# Ratchet Review Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conservative-by-default global Ratchet review-trigger mode and commit fixer dispatch state before long-running ACP turns complete.

**Architecture:** Persist a two-value `RatchetReviewTriggerMode` in `UserSettings`, pass it into PR-state classification, and keep inline threads separate from top-level review summaries and ordinary PR comments. Refactor fixer prompt delivery to return an in-flight completion handle so the Ratchet dispatch record and workspace poll can complete immediately after prompt initiation, while later prompt failure is settled through the existing conditional dispatch outcome.

**Tech Stack:** TypeScript, Prisma/SQLite, Express+tRPC, React, Vitest, Biome

## Global Constraints

- `CHANGES_REQUESTED` is the global default for existing and new settings rows.
- Both modes trigger on failed CI, merge conflicts, `CHANGES_REQUESTED`, and unresolved inline review threads.
- Only `ALL_REVIEW_FEEDBACK` permits top-level `COMMENTED` review summaries to trigger.
- Ordinary PR conversation comments never affect review triggering, prompts, or review snapshot identity.
- Resolved inline comments remain in snapshot timestamp calculation but not in prompts or actionable counts.
- Do not add provider-specific parsing.
- The workspace poll must not await ACP turn completion after a prompt is initiated and its dispatch record is persisted.
- Preserve conditional disable-race cleanup, active-session pointer CAS behavior, and bounded `DIED` retries.

---

### Task 1: Persist and expose the global review-trigger mode

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260717160000_add_ratchet_review_trigger_mode/migration.sql`
- Modify: `src/backend/services/settings/resources/user-settings.accessor.ts`
- Modify: `src/backend/trpc/user-settings.trpc.ts`
- Modify: `src/backend/trpc/user-settings.router.test.ts`
- Modify: `src/shared/schemas/export-data.schema.ts`
- Modify: `src/backend/orchestration/data-backup.service.ts`
- Modify: `src/backend/orchestration/data-backup.service.test.ts`

**Interfaces:**
- Produces: Prisma enum `RatchetReviewTriggerMode` with `CHANGES_REQUESTED | ALL_REVIEW_FEEDBACK`
- Produces: `UserSettings.ratchetReviewTriggerMode: RatchetReviewTriggerMode`
- Produces: `userSettings.update({ ratchetReviewTriggerMode })`

- [ ] **Step 1: Add failing settings and backup tests**

Update user-settings router fixtures and assertions to include:

```typescript
ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
```

Add an update test that sends `ALL_REVIEW_FEEDBACK` and expects the query service to receive it.
Update backup fixtures so export/import round-trips `ratchetReviewTriggerMode`, and add an old-backup
parse assertion that omitting the field produces `CHANGES_REQUESTED`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec vitest run src/backend/trpc/user-settings.router.test.ts src/backend/orchestration/data-backup.service.test.ts
```

Expected: failures because the generated settings type, tRPC schema, and export schema do not expose
`ratchetReviewTriggerMode`.

- [ ] **Step 3: Add the Prisma enum, field, and migration**

Add to `prisma/schema.prisma`:

```prisma
enum RatchetReviewTriggerMode {
  CHANGES_REQUESTED
  ALL_REVIEW_FEEDBACK
}
```

Add to `UserSettings`:

```prisma
ratchetReviewTriggerMode RatchetReviewTriggerMode @default(CHANGES_REQUESTED)
```

Create the SQLite migration:

```sql
ALTER TABLE "UserSettings"
ADD COLUMN "ratchetReviewTriggerMode" TEXT NOT NULL DEFAULT 'CHANGES_REQUESTED';
```

Run:

```bash
pnpm db:generate
```

Expected: Prisma client generation exits zero and generated `UserSettings` types expose the enum.

- [ ] **Step 4: Wire settings validation, persistence, and backup**

Import `RatchetReviewTriggerMode` from `@prisma-gen/client` in the settings accessor and tRPC router.
Add the accessor input field:

```typescript
ratchetReviewTriggerMode?: RatchetReviewTriggerMode;
```

Use `CHANGES_REQUESTED` in all create/default branches. Add to the tRPC update object:

```typescript
ratchetReviewTriggerMode: z.nativeEnum(RatchetReviewTriggerMode).optional(),
```

Add to the export schema with backwards compatibility:

```typescript
ratchetReviewTriggerMode: z
  .nativeEnum(RatchetReviewTriggerMode)
  .optional()
  .default(RatchetReviewTriggerMode.CHANGES_REQUESTED),
```

Include the field in import/export mappings and fixtures.

- [ ] **Step 5: Run focused tests and Prisma schema checks**

```bash
pnpm exec vitest run src/backend/trpc/user-settings.router.test.ts src/backend/orchestration/data-backup.service.test.ts
pnpm check:prisma-schema
```

Expected: focused tests and schema validation pass.

- [ ] **Step 6: Commit settings support**

```bash
git add prisma src/backend/services/settings/resources/user-settings.accessor.ts src/backend/trpc/user-settings.trpc.ts src/backend/trpc/user-settings.router.test.ts src/shared/schemas/export-data.schema.ts src/backend/orchestration/data-backup.service.ts src/backend/orchestration/data-backup.service.test.ts
git commit -m "Add ratchet review trigger setting"
```

---

### Task 2: Classify actionable review signals by mode

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `RatchetReviewTriggerMode`
- Produces: `computeLatestReviewActivityAtMs(prDetails, reviewComments, authenticatedUsername, reviewTriggerMode)`
- Produces: `buildReviewSummariesForPrompt(prDetails, authenticatedUsername, reviewTriggerMode)`
- Produces: `fetchPRState({ ..., reviewTriggerMode })`

- [ ] **Step 1: Add failing helper tests for mode-specific summaries and timestamps**

Add cases proving:

```typescript
expect(
  buildReviewSummariesForPrompt(prWithCommentedSummary, null, 'CHANGES_REQUESTED')
).toEqual([]);

expect(
  buildReviewSummariesForPrompt(prWithCommentedSummary, null, 'ALL_REVIEW_FEEDBACK')
).toHaveLength(1);
```

Add a `CHANGES_REQUESTED` body case that remains included in both modes. Add timestamp cases proving
ordinary `prDetails.comments` do not contribute, resolved and unresolved inline comment timestamps
do contribute, and `COMMENTED` review submissions contribute only in `ALL_REVIEW_FEEDBACK`.

- [ ] **Step 2: Add failing service-level dispatch tests**

Add cases to `ratchet.service.test.ts`:

- default mode + unresolved inline `COMMENTED` thread dispatches;
- default mode + top-level `COMMENTED` summary only waits;
- broad mode + top-level `COMMENTED` summary dispatches;
- default mode + `CHANGES_REQUESTED` body dispatches;
- a coverage comment update alone remains a clean PR and waits.

Mock `userSettingsAccessor.get()` with the selected mode in each case.

- [ ] **Step 3: Run focused Ratchet tests and verify RED**

```bash
pnpm exec vitest run src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: failures because mode is not accepted and ordinary PR comments still advance activity.

- [ ] **Step 4: Implement mode-aware review classification**

Update `computeLatestReviewActivityAtMs` to remove `prDetails.comments` from its entries and filter
top-level reviews as follows:

```typescript
const includeReview =
  state === 'CHANGES_REQUESTED' ||
  (reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' && state === 'COMMENTED');
```

Always include timestamps from all inline review comments before resolution filtering. Update
`buildReviewSummariesForPrompt` so `CHANGES_REQUESTED` is accepted in both modes and `COMMENTED` only
in broad mode, while retaining authenticated-author and stale-approval filtering.

Add `reviewTriggerMode` to `fetchPRState`, use it for snapshot timestamp and prompt summaries, and
continue combining allowed summaries with unresolved inline comments.

- [ ] **Step 5: Read the global setting before PR classification**

In `RatchetService.processWorkspace`, load `userSettingsAccessor.get()`, pass
`settings.ratchetReviewTriggerMode` through `fetchPRState`, and leave CI/merge decisions unchanged.
Keep the existing prompt reply setting lookup local to dispatch unless a single settings read can be
passed cleanly without widening unrelated interfaces.

- [ ] **Step 6: Run focused Ratchet tests and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: all focused Ratchet tests pass.

- [ ] **Step 7: Commit review classification**

```bash
git add src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Filter ratchet review triggers by mode"
```

---

### Task 3: Commit dispatch state before ACP turn completion

**Files:**
- Modify: `src/backend/services/ratchet/service/fixer-session.service.ts`
- Modify: `src/backend/services/ratchet/service/fixer-session.service.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Produces: started acquisition result with `promptCompletion?: Promise<boolean>`
- Preserves: `{ status: 'started'; sessionId: string; promptSent: boolean }` semantics where
  `promptSent` means prompt execution was initiated
- Consumes: `workspaceAccessor.recordRatchetSessionEnd(workspaceId, sessionId, 'DIED')`

- [ ] **Step 1: Add a failing fixer-session test for non-blocking prompt initiation**

Use a deferred `sendSessionMessage` promise. Assert `acquireAndDispatch()` resolves to a started
result before the deferred turn completes and exposes the in-flight completion promise. Resolve the
deferred promise and assert completion becomes `true`.

- [ ] **Step 2: Add failing Ratchet lifecycle tests**

Cover these cases with deferred promises:

- the dispatch record is written and `commitSideEffects` runs while prompt completion is pending;
- a pending prompt longer than the workspace timeout does not abort after persistence;
- a completion resolving `false` after persistence conditionally records `DIED` and stops the
  matching session;
- a completion callback for an older session cannot settle a newer active pointer;
- a record write failure stops the session even though prompt completion is pending.

- [ ] **Step 3: Run focused lifecycle tests and verify RED**

```bash
pnpm exec vitest run src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: the deferred acquisition remains pending and dispatch persistence is not reached.

- [ ] **Step 4: Return prompt completion without awaiting it**

Change the started result type to:

```typescript
| {
    status: 'started';
    sessionId: string;
    promptSent?: boolean;
    promptCompletion?: Promise<boolean>;
  }
```

Replace the awaited send in `start_empty_and_send` with a synchronous initiation helper that:

- returns `null` when the session is not running;
- otherwise invokes `session.sendSessionMessage` immediately;
- maps completion to `true` and rejection to `false` with existing warning logging.

Return `promptSent: promptCompletion !== null` and the promise itself. Do not await it in
`acquireAndDispatch`.

- [ ] **Step 5: Persist first, then monitor the committed prompt**

In the started-result handler, preserve the existing `promptSent: false` cleanup. For an initiated
prompt:

1. call `recordRatchetDispatchIfEnabled`;
2. if it succeeds, mark side effects committed immediately;
3. attach a rejection/false-result observer to `promptCompletion`;
4. conditionally settle the same session as `DIED` and stop it when completion fails.

Use the accessor CAS on `ratchetActiveSessionId` so an old completion cannot affect a replacement.
Log asynchronous monitoring errors rather than creating an unhandled rejection.

- [ ] **Step 6: Run focused lifecycle tests and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: lifecycle tests pass and no test reports an unhandled promise rejection.

- [ ] **Step 7: Commit dispatch lifecycle changes**

```bash
git add src/backend/services/ratchet/service/fixer-session.service.ts src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Record ratchet dispatches before turn completion"
```

---

### Task 4: Add the Admin option and update documentation

**Files:**
- Modify: `src/client/routes/admin-page.tsx`
- Modify: `src/client/routes/admin-page.test.tsx`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `settings.ratchetReviewTriggerMode`
- Produces: Admin select that writes `CHANGES_REQUESTED | ALL_REVIEW_FEEDBACK`

- [ ] **Step 1: Add failing Admin UI tests**

Extend the settings fixture with `ratchetReviewTriggerMode: 'CHANGES_REQUESTED'`. Assert the Ratchet
section renders **Review feedback trigger** and **Changes requested and unresolved threads**. Add an
interaction assertion that selecting **All review feedback** calls:

```typescript
updateSettings.mutate({ ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK' });
```

- [ ] **Step 2: Run the focused UI test and verify RED**

```bash
pnpm exec vitest run src/client/routes/admin-page.test.tsx
```

Expected: label/selection assertions fail because the control does not exist.

- [ ] **Step 3: Implement the Admin select**

Add a select beside the existing Ratchet permission settings with the two approved labels and this
fallback:

```typescript
const currentReviewTriggerMode =
  settings?.ratchetReviewTriggerMode ?? 'CHANGES_REQUESTED';
```

Validate the selected string against the two enum values before mutating. Disable the control while
the settings mutation is pending. Explain that the broad mode also lets top-level `COMMENTED`
summaries start sessions and that ordinary PR comments never do.

- [ ] **Step 4: Update feature documentation**

Update the Ratchet feature note in `AGENTS.md` to describe the global modes, conservative default,
ordinary-comment exclusion, and prompt-initiation dispatch commitment.

- [ ] **Step 5: Format and run focused tests**

```bash
pnpm exec biome check --write prisma/schema.prisma src/backend/services/settings/resources/user-settings.accessor.ts src/backend/trpc/user-settings.trpc.ts src/backend/trpc/user-settings.router.test.ts src/shared/schemas/export-data.schema.ts src/backend/orchestration/data-backup.service.ts src/backend/orchestration/data-backup.service.test.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/backend/services/ratchet/service/fixer-session.service.ts src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts src/client/routes/admin-page.tsx src/client/routes/admin-page.test.tsx AGENTS.md
pnpm exec vitest run src/backend/trpc/user-settings.router.test.ts src/backend/orchestration/data-backup.service.test.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/client/routes/admin-page.test.tsx
```

Expected: formatting and all focused tests pass.

- [ ] **Step 6: Commit UI and documentation**

```bash
git add src/client/routes/admin-page.tsx src/client/routes/admin-page.test.tsx AGENTS.md
git commit -m "Expose ratchet review trigger mode"
```

---

### Task 5: Verify, review, and publish

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/ratchet-review-trigger-pr.md`

**Interfaces:**
- Consumes: completed implementation and tests
- Produces: verified branch and draft GitHub pull request

- [ ] **Step 1: Run repository verification**

```bash
pnpm check:prisma-schema
pnpm test
pnpm typecheck
pnpm check
pnpm build
```

Expected: every command exits zero with no test failures, type errors, dependency violations, or
build errors. Existing documented warnings may remain.

- [ ] **Step 2: Review the complete diff**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status --short
```

Expected: no whitespace errors, no unrelated files, and a clean worktree after final commits.

- [ ] **Step 3: Commit any verification-only corrections**

If verification required changes, rerun the affected focused test, then:

```bash
git add <affected-files>
git commit -m "Fix ratchet review trigger verification"
```

Expected: the correction commit contains only verified fixes.

- [ ] **Step 4: Push and open the pull request**

Push the current branch and create a draft PR with:

```markdown
## Summary
- add a conservative-by-default global Ratchet review-trigger mode
- ignore ordinary PR conversation comments when computing review activity
- record fixer dispatches before long-running ACP turns complete

## Verification
- `pnpm check:prisma-schema`
- `pnpm test`
- `pnpm typecheck`
- `pnpm check`
- `pnpm build`
```

Expected: the branch is pushed and the draft PR URL is returned.
