# Chat usage control

The composer's usage control: the conversation's context occupancy, the
provider's plan limits and the Compact action. The [chat guide](../AGENTS.md)
covers the feature. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This directory owns how occupancy and plan limits are shown and when Compact is
offered. It does not own:

- The occupancy reading: `updateTokenStatsFromResult` in
  `src/lib/chat-protocol.ts` takes it from each ACP `usage_update`.
- Plan limit reads: the `getProviderUsage` procedure in
  `src/backend/trpc/session.trpc.ts`, open to trusted local clients only, over
  the session capsule's `providerUsageService` and, for Codex, the account
  service in `src/backend/services/codex-accounts/`.
- What Compact sends: `/compact` through the session queue with the composer's
  draft and attachments kept, from `handleCompact` in
  `src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx`.
- Compaction progress and the context boundary:
  `src/shared/acp-protocol/session-update-translator.ts` and the chat reducer.

## Public surface

`ProviderUsageControl`, which `../chat-input/chat-input.tsx` renders for Claude
and Codex sessions, passing it as busy while the session runs, stops or has
queued messages, and as disabled while the composer is.

## Invariants

- Context shows the latest occupancy reading, which replaces the one before even
  when it is higher (native compaction can raise occupancy in a short
  conversation), is never derived from cumulative token totals, and reads
  "Context unavailable" until the provider reports one.
  `provider-usage-control.test.tsx`, `usage-stats-utils.test.ts`,
  `src/lib/chat-protocol.test.ts`.
- Compact is disabled while the session is busy, compacting or disabled, while
  the context is unknown, and without a compact callback.
  `provider-usage-control.test.tsx`, `../chat-input/chat-input.test.tsx`.
- A plan reading that is unavailable or failed shows its message or a retry
  text, never a percentage, and Refresh stays offered.
  `provider-usage-control.test.tsx`.
- Compact sends `/compact` through the queue and keeps the composer's draft and
  attachments.
  `src/client/routes/projects/workspaces/workspace-detail-chat-content.test.tsx`,
  `../use-chat-state.integration.test.tsx`.

## Map

- `provider-usage-control.tsx`: `ProviderUsageControl` reads plan limits,
  polling only while the popover is open and once after work ends;
  `UsageControl` renders them.
- `usage-stats-utils.ts`: the occupancy percentage and the warning thresholds.
- `context-window-indicator.tsx`, `usage-stats-popover.tsx`: an older indicator
  and its popover, rendered only in Storybook.
