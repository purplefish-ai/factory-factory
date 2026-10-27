# Provider Usage and Compaction Implementation Plan

> **For agentic workers:** Use the approved Combined mockup and user request as
> the specification. Implement focused tasks with failing tests first, then
> review the complete diff.

**Goal:** Show real context occupancy and provider plan limits in one quiet
composer control, with a Compact action and understandable compaction messages.

**Architecture:** Retain ACP usage snapshots as current context occupancy,
separate from cumulative token accounting. Read account quotas without sending
model turns or modifying active conversations; cache and coalesce provider
reads. Send `/compact` through the existing session message pipeline and
translate native ACP compaction lifecycle updates.

**Tech stack:** Existing React, tRPC, Zod, Vitest and upstream ACP adapters.

**Spec:** User-approved Combined mockup in this chat; add Compact, live quotas
and context for Claude and Codex, and verify real compaction for both providers.

## Global Constraints

- Respect the pinned Node 26.12.1 and pnpm 12.15.0 toolchain.
- No sample readings in production, inferred subscription quotas or scraped UI.
- Missing and failed readings stay explicit; do not substitute zero.
- Provider history remains visible; compacting changes model context, not chat
  history. Failed compaction must not be reported as completed.
- Preserve native authentication and provider adapters; never expose
  credentials.
- Independent workers own separate files and must preserve each other's changes.

## Shared Interfaces

- `src/shared/provider-usage.ts`: `ProviderPlanUsage`, with provider
  `CLAUDE | CODEX`, status `available | unavailable | error`, windows containing
  `id`, `label`, `usedPercent`, `resetsAt` (Unix seconds or null), `updatedAt`
  (ISO timestamp), and optional `message`.
- `TokenStats.contextUsedTokens?: number | null`: latest ACP `used`; existing
  `contextWindow` holds ACP `size`. Missing occupancy must not use accumulated
  token counts. Existing cumulative counters retain their accounting meaning.
- `session.getProviderUsage({ provider })`: returns `ProviderPlanUsage` and
  coalesces/caches reads for 30 seconds.
- Compact uses `onSend('/compact')`, disabled during running, stopping,
  compaction or connection setup; preserves any composer draft.

## Review Focus

- Compaction decreases occupancy rather than adding it to prior usage.
- Failed/cancelled compaction terminates progress without a success message.
- Unavailable quota/auth data never appears as unused quota.
- Switching provider/session cannot show the previous session's context.
- Refresh and cleanup leave no provider processes, model turns or tool calls.

## Tasks

### Task 1: Provider plan usage backend

- [x] Test schema normalization for both providers, missing windows, reset
      units, cache coalescing and error recovery.
- [x] Implement bounded read-only provider probes using native runtimes and
      credentials, with 30-second successful-read caching.
- [x] Expose the service through the session capsule and tRPC application
      context.
- [x] Run focused tests and typecheck.

### Task 2: Combined composer control

- [x] Test current context snapshots, missing data, plan warnings and Compact
      dispatch/disabled behavior.
- [x] Implement the approved compact ring, percentage and popover using current
      occupancy, provider quota windows and a compact Compact button.
- [x] Mount the control beside Send on desktop and mobile, preserve draft input,
      and add Storybook states.
- [x] Verify light/dark and narrow layouts in Storybook.

### Task 3: Native compaction integration and delivery

- [x] Negotiate and translate both adapters' native compaction lifecycle events.
- [x] Cover success, failure, cancellation, boundary messaging and post-compact
      context updates with focused tests.
- [x] Run disposable live Claude/Codex sessions: seed a small conversation,
      record context, compact, verify lifecycle messages and follow-up recall.
- [x] Update runtime documentation; run CONTRIBUTING checks and full tests,
      review the diff, and report exact live-test limitations.

## Progress

- Repository started clean on main. The resulting implementation is committed on
  `codex/provider-usage` and included in this revision.
- Proto installation fails its offline check, but official HTTPS downloads work.
  Node 26.12.1 was downloaded to `/private/tmp/ff-usage-toolchain/node` and its
  published SHA-256 checksum verified. Pnpm 12.15.0 is available from the same
  task-only toolchain.

- Verification: `pnpm check:fix`, `pnpm typecheck`, `pnpm check`, `pnpm build`,
  `pnpm test` (7,173 passed), `pnpm test:integration` (191 passed), and
  `pnpm test:e2e:mobile` (3 passed). Socket/IPC checks ran with the local access
  their fixtures require.
- Disposable live quota reads and live compaction/marker recall passed for both
  providers. Native Codex compaction increased the short test conversation's
  reported occupancy; the control correctly replaces snapshots without promising
  a reduction. Claude's duplicate completion updates were deduplicated.
- Cubic review found two issues, both fixed with regressions: quota subprocess
  tree cleanup and retaining ordered compaction markers across viewer
  reconnects.
- Existing limitation: a full backend restart imports provider history through
  loaders that omit historic compaction markers for both providers. Active
  transcript reconnect/replay retains the new marker; history import was not
  expanded in this change.
