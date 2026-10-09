# Multiple Workspace PRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Associate multiple PRs with a workspace, watch every open PR, and
present them through one compact menu.

**Architecture:** Replace the singleton PR cache with a collection and move
discovery and PR-specific dispatch bookkeeping into separate owned tables. Keep
one workspace automation toggle and atomic active-fixer ownership. Derive
workspace summaries from every active association; explicit PR actions always
carry a target identity.

**Tech Stack:** TypeScript, Prisma/SQLite, Express/tRPC, React, Radix/shadcn UI,
Vitest, and Storybook.

**Spec:**
[Approved design](../specs/2026-10-08-multiple-workspace-prs-design.md).

## Global Constraints

- Ratchet watches every open PR; at most one active fixer per workspace.
- Adding a PR never replaces an existing association; duplicate attachment
  preserves dispatch history.
- PR attachment and refresh never overwrite the workspace branch.
- Open states are `DRAFT`, `OPEN`, `APPROVED`, and `CHANGES_REQUESTED`; attached
  `NONE` remains nonterminal until refreshed.
- Removed associations remain discovery tombstones until explicitly reattached.
- Keep one compact menu, existing theme tokens, Phosphor icons, keyboard
  navigation, mobile access, and the labels `PRs`, `Add PR`, `Syncing`,
  `Run review`, and `Remove from workspace`.
- Preserve existing review filtering, dispatch deduplication, bounded crash
  retries, poll cadence, rate budget, lifecycle shutdown, and session
  protections.
- Use Node `>=26.8.1` and `pnpm@12.4.2`; use no new product dependencies.
- Keep sole model writers in workspace resources, barrel boundaries intact, Zod
  validation at boundaries, and cross-service coordination in orchestration.
- Retain version 4 backup imports; export the collection as version 5.
- Do not bypass pre-commit checks, grow legacy file ceilings, or weaken tests.

## Review Focus

1. Two repositories with the same PR number must have independent attachments,
   fetch coordination, prompts, and reviews; test in Tasks 2, 3, and 5.
2. A fetch begun before detach and reattach must be rejected even when the
   stable PR ID is reused; pin association revisions in Task 2.
3. Restarting with an active fixer must recover its exact PR ownership without
   adopting another PR's old session; test in Tasks 1 and 3.
4. A repository lookup racing removal or a branch rename must not resurrect the
   PR or consume another candidate's claim; test in Task 2.
5. Long titles, many rows, pending mutations, and rapid workspace navigation
   must keep the menu usable and prevent late callbacks changing another
   workspace; test in Task 5.

## File boundaries and execution order

The workspace capsule owns persistence; the GitHub capsule owns observations;
Ratchet owns decisions; shared modules own aggregate projections; the workspace
feature owns the reusable menu. Keep existing PR review detail rendering intact.

Tasks 1–6 depend on the previous task's interfaces. During Task 1, maintain a
temporary singleton adapter for unmigrated callers so generated Prisma changes
do not require bypassing type checks. Migrate each caller to explicit identities
or collection summaries in its owning task. Remove the adapter in Task 6 before
delivery; no automation or UI behavior may depend on it in the final diff. Each
task ends with focused tests and a type check before committing.

The checkout currently lacks installed dependencies. At execution start, use
`pnpm install --frozen-lockfile` and normal sandbox escalation if registry
access requires it. Do not use a different checkout's dependency versions for
product verification. Existing local Prettier is sufficient to format this plan
only.

### Task 1: PR storage, migration, and public collection types

**Files:**

- Modify: `prisma/schema.prisma`, `src/backend/services/registry.ts`,
  `scripts/check-single-writer.mjs`.
- Create:
  `prisma/migrations/20261008120000_multiple_workspace_prs/migration.sql`,
  `src/backend/services/workspace/resources/workspace-pr-discovery.accessor.ts`,
  `src/backend/services/workspace/resources/workspace-pr-ratchet.accessor.ts`,
  `src/shared/workspace-pr.ts`,
  `src/backend/multiple-workspace-prs.migration.test.ts`.
- Modify: `src/backend/services/workspace/resources/workspace-pr.accessor.ts`,
  `src/backend/services/workspace/resources/workspace-ratchet.accessor.ts`,
  `src/backend/services/workspace/resources/workspace.accessor.ts`,
  `src/backend/services/workspace/types.ts`,
  `src/backend/services/settings/resources/data-backup.accessor.ts`,
  `src/backend/orchestration/data-backup.service.ts`.
- Test: existing workspace accessor and single-writer test files.

**Interfaces:**

- `WorkspacePRIdentity = { workspaceId: string; prId: string }` in workspace
  types; use this exact target shape for persistence and services.
- `WorkspacePullRequestSchema` in `src/shared/workspace-pr.ts`: `id`, `url`,
  nullable `number`, `title`, `headRefName`, `baseRefName`, `reviewState`, and
  `syncedAt`; typed `state`, `ciStatus`, `hasMergeConflict`; `ratchet` contains
  check time, dispatch outcome, retry count, and stalled state. Wire dates are
  nullable ISO strings. Export `WorkspacePullRequest` from that schema.
- `workspacePrAccessor.findByIdentity(target): Promise<WorkspacePRRecord | null>`
  and `list(workspaceId): Promise<WorkspacePRRecord[]>`; `WorkspacePRRecord`
  includes the generated PR row and its PR-specific Ratchet row. Lists exclude
  detached records. Resource-only transaction variants accept
  `Prisma.TransactionClient` for cross-table atomic writes.

- [ ] Add migration regressions using the existing SQLite migration harness.
      Populate old no-URL, open, merged, closed, and active-dispatch rows.
      Assert exact URL/status/cursor preservation, no empty PR association,
      matching active PR ownership, independent dispatch rows, and
      `PRAGMA foreign_key_check` empty.
- [ ] Run `pnpm test src/backend/multiple-workspace-prs.migration.test.ts`;
      expect failure because the new migration and relations do not exist.
- [ ] Change `Workspace.pr` to `prs`; add PR `id`, non-null `url`, nullable
      metadata, `detachedAt`, and integer `revision` defaulting to zero. Add
      unique `(workspaceId, url)` and workspace/sync indexes. Create one-to-one
      `WorkspacePRDiscovery` and `WorkspacePRRatchet` models with indexed
      foreign keys and cascading deletion. Keep the workspace Ratchet
      toggle/check time and active session pointer; add its nullable, indexed
      `activePrId`.
- [ ] Implement the migration. Use `legacy-pr-<workspaceId>` for migrated PR
      IDs, move discovery for every workspace, transfer dispatch history only to
      known PRs, and preserve the matching workspace active pointer. Set
      missing-PR ownership to null. Do not rewrite historical migration files.
- [ ] Register both new models and accessors with the existing ownership checks;
      update their regression fixtures without adding blanket exceptions. Remove
      PR snapshot methods' permission to write workspace branches when those
      methods are migrated in Task 2.
- [ ] Implement collection readers and wire serialization. Update workspace
      creation, joined reads, and backup Prisma relation references. Keep
      temporary adapter functions at the accessor boundary for unchanged
      singleton callers; translate legacy nested creates to the collection. Keep
      version 4 export serialization working until Task 6 replaces it.
- [ ] Run `pnpm db:generate`, the migration/accessor/ownership tests,
      `pnpm check:ownership`, `pnpm check:fk-indexes`, and `pnpm typecheck`.
      Expect passing tests, no ownership/index violations, and no type errors.
- [ ] Inspect the diff and commit:
      `Support PR collections in workspace storage`.

### Task 2: Add, remove, refresh, and discover independent PRs

**Files:**

- Modify: workspace PR/discovery accessors and
  `src/backend/services/workspace/service/lifecycle/workspace-pr-snapshot.service.ts`,
  `src/backend/services/workspace/service/query/workspace-maintenance.service.ts`,
  `src/backend/services/workspace/service/lifecycle/data.service.ts`.
- Modify: `src/backend/services/github/service/pr-snapshot.service.ts`,
  `src/backend/services/github/service/pr-fetch-coordinator.ts`,
  `src/backend/services/github/service/github-cli.service.ts`,
  `src/backend/services/github/service/bridges.ts`,
  `src/backend/services/workspace/service/bridges.ts`,
  `src/backend/orchestration/domain-bridges.orchestrator.ts`,
  `src/backend/orchestration/scheduler.service.ts`,
  `src/backend/trpc/workspace.trpc.ts`, and capsule barrels.
- Test: co-located snapshot/coordinator/scheduler/accessor tests and
  `src/backend/orchestration/pr-attachment.integration.test.ts`.

**Interfaces:**

- `workspacePrSnapshotService.attach(workspaceId, url): Promise<{ prId: string; created: boolean; reattached: boolean }>`
  persists the association before I/O.
- `detach(target: WorkspacePRIdentity): Promise<boolean>` marks the tombstone,
  increments revision, and clears matching active ownership transactionally.
- `record(target, observation, expectedRevision): Promise<boolean>` updates only
  an active matching row/revision and resets only its settled dispatch history
  when relevant observations change. Observation data includes cached status,
  metadata, and the caller's observation time.
- `attachDiscoveredPRsIfClaimMatches(workspaceId, claim, urls): Promise<string[]>`
  validates one discovery claim and attaches the whole new batch atomically; it
  skips tombstones and duplicates and returns newly created PR IDs.
- `prSnapshotService.refreshPR(target): Promise<PRSnapshotRefreshResult>`
  fetches that association; `refreshWorkspace(workspaceId)` iterates active
  associations. Extend attachment results with `prId` and explicit initial-fetch
  failure.
- `prFetchCoordinator.coordinate(target: WorkspacePRIdentity, fetch, options)`
  scopes claims/cooldowns to PR IDs and registers their workspace membership;
  `removeWorkspace` clears keys registered for that workspace.
- tRPC `attachPR({id, prUrl})` returns the association plus sync outcome;
  `detachPR({workspaceId, prId})` is scoped to one association.

- [ ] Add tests that attach A then B and assert two records, preserved A
      dispatch history, unchanged workspace branch, duplicate idempotency, and
      neutral B recovery after a failed fetch. Assert a target from another
      workspace is rejected. Include two repositories with equal PR numbers.
- [ ] Add deferred-fetch tests for removal and detach/reattach. Assert both old
      results are rejected, while a fetch begun at the new revision succeeds.
      Add discovery tests for several PRs under one claim, tombstone
      preservation, reused branches, rename races, and independent A/B
      cooldowns.
- [ ] Run affected snapshot, attachment, scheduler, and coordinator tests;
      expect the new multi-PR assertions to fail against singleton behavior.
- [ ] Implement the interfaces above. Extend fetched metadata with title/head/
      base branch. Replace workspace-scoped PR write queues with PR-scoped
      queues; detach/reattach must invalidate results via `revision`, not queue
      timing alone. Keep failed initial fetch associations, and do not return a
      generic mutation failure that makes the UI believe its successful
      attachment was discarded.
- [ ] Update discovery candidates to include workspaces with existing PRs. Match
      all repository results by exact tracked branch and the existing
      creation-time rule; choose the newest eligible workspace per PR, then
      group its URLs under one claim. Preserve batching, due order, retry
      schedule, and capacity limits. Sync stale association candidates
      independently.
- [ ] Remove PR-driven workspace branch writes and their obsolete ownership
      permissions. Wire target-aware bridges and events carrying `workspaceId`
      and `prId`; add a detachment event for snapshot invalidation and lifecycle
      cleanup.
- [ ] Run affected tests, `pnpm check:ownership`, and `pnpm typecheck`; expect
      passing results. Commit: `Track and refresh workspace PRs independently`.

### Task 3: Observe all PRs and serialize targeted fixer dispatches

**Files:**

- Modify: PR/workspace Ratchet accessors and
  `src/backend/services/workspace/service/lifecycle/workspace-ratchet.service.ts`.
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`,
  `ratchet.types.ts`, `bridges.ts`, `ratchet-active-session.helpers.ts`,
  `ratchet-fixer-dispatch.helpers.ts`, `ratchet-pr-state.helpers.ts`,
  `ratchet-workspace-check-coordinator.ts`, and `fixer-session.service.ts` under
  the same service directory.
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`,
  `src/backend/services/session/resources/agent-session.accessor.ts`,
  `src/backend/services/session/service/lifecycle/session-lifecycle-external-ports.ts`,
  `src/backend/prompts/ratchet-dispatch.ts`, and `prompts/ratchet/dispatch.md`.
- Test: co-located Ratchet, fixer, prompt, session accessor, and bridge tests.

**Interfaces:**

- `workspaceRatchetService.findCandidates()` returns workspaces with `prs`
  eligible for checks; `findCandidateById(workspaceId)` returns that collection.
  Each candidate carries Task 1's PR record and PR-scoped dispatch history.
- `claimDispatch(target, {sessionId, snapshotKey, retryCount}): Promise<boolean>`
  atomically guards enabled state, active association, and empty/matching
  workspace ownership, then records workspace and PR dispatch ownership.
- `recordSessionEnd(workspaceId, sessionId, outcome): Promise<boolean>` settles
  the PR identified by current workspace ownership. Preserve this lifecycle
  callback signature; reject mismatched session IDs.
- `markDispatchStalled(target, snapshotKey): Promise<boolean>` guards that PR's
  snapshot and enabled state.
- Persist session target metadata as `{ workspacePrId: string }` through the
  session accessor and its Zod validation; pass it in fixer acquisition. A
  session may only be reused/adopted for the same target PR.
- Add `prId` to per-PR Ratchet results/events. Keep workspace check coordination
  responsible for serialization; observe siblings before choosing one dispatch.

- [ ] Add a two-PR Ratchet test: both GitHub reads occur; only one fixer starts;
      ending it makes the other eligible. Assert A and B use independent
      snapshot keys, retry counters, stalled flags, review cursors, and exact
      prompt URLs.
- [ ] Add concurrent claim/disable/removal tests and restart fixtures. Assert a
      late A completion cannot clear B, an exhausted A cannot starve B, and a
      legacy migrated active session recovers its mapped PR without being
      adopted for B. Assert merging or removing A never stops B's fixer or a
      user session.
- [ ] Run affected Ratchet tests; expect failures on missing per-PR ownership.
- [ ] Implement per-PR observations/history and oldest-check-time ordering with
      PR ID as tie breaker. An active workspace fixer prevents only new
      dispatches; siblings still get observed. Preserve the existing three-crash
      retry ceiling, prompt-start persistence, stop semantics, and active
      user-session guard.
- [ ] Claim the workspace slot and PR record before starting or messaging a
      fixer. If the claim loses, do not launch work; if startup fails,
      conditionally settle only that claim. Scope terminal-PR cleanup and
      session reuse to target metadata or migrated `activePrId`. Include target
      branch in the existing untrusted-data-safe prompt; attaching/viewing never
      checks out a branch.
- [ ] Run Ratchet, session, prompt, and bridge regressions plus
      `pnpm typecheck`; expect passes. Commit:
      `Watch every workspace PR with serialized fixers`.

### Task 4: Aggregate status, snapshots, archive, and completion

**Files:**

- Create: `src/shared/workspace-pr-summary.ts` and its co-located tests.
- Modify: `src/shared/workspace-snapshot.ts`,
  `src/shared/core/workspace-sidebar-status.ts`,
  `src/shared/workspace-sidebar-status.ts`,
  `src/backend/lib/workspace-derived-state.ts`,
  `src/backend/services/workspace/service/state/flow-state.ts`,
  `src/backend/services/workspace/service/query/workspace-query.service.ts`,
  `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`,
  `src/backend/orchestration/event-collector.orchestrator.ts`,
  `src/backend/orchestration/ratchet-projection.worker.ts`,
  `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`,
  `src/backend/orchestration/workspace-archive.orchestrator.ts`,
  `src/backend/services/periodic-task/service/periodic-task.service.ts`,
  `src/backend/trpc/workspace/children.trpc.ts`,
  `src/client/lib/snapshot-to-workspace.ts`, and archive-dialog call sites.
- Test: co-located summary/snapshot/flow/archive/periodic-task tests,
  `src/testing/workspace-pr-switch.integration.test.ts`.

**Interfaces:**

- `deriveWorkspacePRSummary(prs: readonly WorkspacePullRequest[], ratchetEnabled: boolean): WorkspacePRSummary`
  returns `totalCount`, `openCount`, `hasNonterminal`, `state`, `ciStatus`,
  `hasMergeConflict`, `ratchetState`, and `dispatchStalled`. Summary `state` is
  `NONE`, `OPEN`, `MERGED`, or `CLOSED`; per-PR draft/review state remains in
  `prs`.
- Runtime workspace/snapshot payloads contain `prs` and `prSummary`. Flow and
  sidebar derivations consume summary presence/counts instead of scalar URL. A
  workspace is stalled only when every actionable nonterminal PR is stalled or
  has exhausted retries, no fixer owns the workspace, and no nonterminal PR has
  pending or unknown checks.

- [ ] Add a table of merged+open, closed+open, unknown+merged, failed+pending,
      successful+conflicted, mixed-review, all-merged, mixed-terminal, disabled,
      and empty collections. Assert failure > conflict > running > review >
      ready; no terminal history overrides a nonterminal PR. Assert one stalled
      PR does not hide another actionable PR or a sibling still waiting on CI.
- [ ] Add archive tests requiring confirmation for every nonterminal case and
      snapshot races where adding/removing a PR during a delayed merged
      projection cannot restore old completion state. Assert periodic completion
      detects any attached PR and preserves its specific historical link.
- [ ] Run summary, flow, archive, and snapshot tests; expect new assertions to
      fail.
- [ ] Implement the shared summary. Failure wins over pending/unknown CI;
      terminal-only collections are merged if any merged, otherwise closed.
      Preserve workspace lifecycle/session precedence. Use active ownership to
      derive dispatch state, not whichever PR happens to appear first.
- [ ] Publish collection and summary together from authoritative reads. PR
      events invalidate collection reads rather than patching one workspace-wide
      PR field. Preserve worker retries, generation invalidation, timestamp
      protection, archive suppression, and idle-refresh cooldowns. Map wire
      dates in the client adapter without dropping existing mutation-only
      workspace fields.
- [ ] Migrate archive dialogs, issue notifications, child workspaces, and
      periodic-task handling to the collection/summary. Confirm auto-iteration
      consumers do not retain an indirect singleton completion dependency.
- [ ] Run affected tests and `pnpm typecheck`; expect passes. Commit:
      `Derive workspace status from every associated PR`.

### Task 5: Compact shared menu and explicit review actions

**Files:**

- Create: `src/client/features/workspace/workspace-pr-menu.tsx`,
  `workspace-pr-menu.test.tsx`, `workspace-pr-menu.stories.tsx`, and
  `use-workspace-pr-actions.ts` in the same directory.
- Modify: `src/client/features/workspace/index.ts`,
  `src/client/routes/projects/workspaces/workspace-detail-header.tsx`, its
  `workspace-status.tsx`, `types.ts`, `utils.ts`,
  `adversarial-review-button.tsx`, and `workspace-switcher-dropdown.tsx`.
- Modify: `src/client/components/workspace-item-content.tsx`,
  `src/client/components/app-sidebar.tsx`,
  `src/client/components/use-workspace-list-state.ts`,
  `src/client/features/kanban/kanban-card.tsx`,
  `src/client/routes/projects/workspaces/use-workspace-detail.ts`,
  `src/backend/trpc/adversarial-review.trpc.ts`,
  `src/backend/orchestration/adversarial-review.orchestrator.ts`.
- Test: menu/header/sidebar/board and adversarial-review tests; update relevant
  existing Storybook fixtures.

**Interfaces:**

- `WorkspacePrMenu({workspaceId, prs, compact?, disabled?})` renders one shared
  menu using `WorkspacePullRequest[]`. `compact` is for sidebar/board triggers;
  archived workspaces allow links but disable attachment/removal/review actions.
- `useWorkspacePrActions(workspaceId)` owns add/detach/review mutations, scoped
  cache reconciliation, pending state, and originating-workspace identity.
- tRPC review input is `{workspaceId, prId}`;
  `triggerAdversarialReview(target: WorkspacePRIdentity)` validates the active
  association and open state. Same-target active reviews dedupe; another target
  never returns the first PR's session as if it reviewed the requested PR.

- [ ] Add menu assertions for zero/one/many PRs, open-first order, title
      fallback, syncing status, count trigger, GitHub target links, removal
      confirmation, duplicate attachment, and disabled archived actions. Verify
      keyboard opening, row selection, Escape dismissal, and retained
      pending/error state.
- [ ] Add navigation-race and long-title/many-row fixtures. Assert late
      mutations reconcile the originating workspace without changing a newer
      workspace's menu. Add review tests for equal PR numbers in different
      repositories, explicit ownership validation, and independent target
      selection.
- [ ] Run affected UI/review tests; expect failures on singleton actions.
- [ ] Implement the menu with existing dropdown/dialog primitives, no nested
      interactive controls. Keep one row action submenu, one bottom `Add PR`
      action, bounded scrolling, mobile width, truncation, visible focus, and
      text status. Preserve the single-PR number presentation and use `PRs` plus
      count for many.
- [ ] Replace header's singleton chip/association dialog and sidebar/board PR
      links with the shared menu. Use aggregate status chips. Keep Create PR
      available when the workspace branch has changes and no open PR with that
      head branch. Review buttons directly target the sole eligible PR or open
      the choice for several. Switching/viewing PRs never changes Ratchet
      eligibility or branch.
- [ ] Wire explicit review targets through the orchestrator and session
      metadata; preserve existing read-only review startup and
      untrusted-feedback safeguards.
- [ ] Run affected tests and `pnpm typecheck`. Inspect Storybook at desktop and
      narrow mobile widths for empty, one, many, mixed-terminal, syncing,
      long-title, and pending states. Commit: `Add a compact workspace PR menu`.

### Task 6: Backups, adapter removal, integration, and final verification

**Files:**

- Modify: `src/shared/schemas/export-data.schema.ts`,
  `src/backend/services/settings/resources/data-backup.accessor.ts`,
  `src/backend/orchestration/data-backup.service.ts`, and co-located tests.
- Modify: temporary compatibility adapters introduced in Task 1 and every
  remaining runtime singleton consumer found by the final search.
- Modify: `docs/architecture/pull-requests.md`,
  `docs/architecture/workspace-state.md`, `src/backend/services/AGENTS.md`.
- Create: `src/testing/multiple-workspace-prs.integration.test.ts`.

**Interfaces:**

- Keep the version 4 schema as `exportDataV4Schema`; add `exportDataV5Schema`.
  `exportDataSchema` accepts their union and normalizes imports to version 5
  through `normalizeExportData(input): ExportDataV5`.
- Version 5 workspaces contain active and detached PR records, PR dispatch
  bookkeeping, and workspace discovery/ownership fields. Exports always emit 5;
  restore keeps the existing policy for runtime session pointers.

- [ ] Add version 4 import fixtures with zero/one PR and active dispatch data.
      Assert known associations/cursors survive and no blank PR is created. Add
      a version 5 round trip with multiple PRs, a tombstone, discovery schedule,
      and independent retry/stall state; reject duplicate IDs/URLs and orphan
      targets.
- [ ] Add an integration flow: attach A/B, independently refresh, observe both,
      dispatch one fixer, settle it, then dispatch the other. Merge A and assert
      B remains watched and archive confirmation remains required. Remove B
      during refresh, assert no resurrection, then explicitly reattach and
      recover.
- [ ] Run backup and integration tests; expect version 5 and full-flow failures.
- [ ] Implement versioned schemas and normalized imports. Validate JSON through
      Zod, preserve tombstones and notification cursors, remap PR IDs/ownership
      when restore remaps workspace IDs, and restore all collection rows
      atomically.
- [ ] Remove temporary singleton adapters. Search `WorkspacePR`, `prUrl`,
      `prNumber`, `prState`, and `ratchetDispatch` across runtime code. Retain
      scalar fields only for individual PRs, historical periodic execution
      links, and the version 4 import boundary. Update old fixtures to test the
      correct collection behavior; explain changed assertions rather than
      weakening them.
- [ ] Update architecture guidance and side-table ownership notes. Keep its
      sibling `CLAUDE.md` import intact. Remove obsolete comments that promise a
      singleton wire or version 4 export. Run file-ceiling lowering only for
      legacy files that were reduced; extract focused helpers when existing
      files would grow.
- [ ] Run `pnpm check:fix`, `pnpm typecheck`, affected Vitest suites,
      `pnpm test:integration`, `pnpm check`, and `pnpm check:prisma-schema`.
      Expect zero relevant failures, ownership/index violations, or migration
      drift. Inspect the complete diff and repeat successful checks only after
      new edits.
- [ ] Commit: `Preserve multiple PRs in backups and verify workspace flows`.
      Report the delivered behavior, actual checks, and any unavailable
      validation. Open a ready-for-review PR only if the user requests a PR;
      never use draft.
