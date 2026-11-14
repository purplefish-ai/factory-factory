# Session data module

Session records, provider and launch resolution, and provider history: reading
Claude Code and Codex history files and projecting them into transcripts. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. This guide so far covers provider history.
Bare file names below are in this directory; paths that start with `src/` are
from the repository root.

## Owns, and does not own

The module owns reading a provider history file, sharing one read and projection
among concurrent callers, the cache of completed projections, and applying a
result to a session store through that store's fences (the hydrator). It does
not own:

- The projection itself (`buildTranscriptFromHistoryCooperatively`) and the
  stores: `../store/session-transcript.ts`, `../store/`.
- When history is hydrated: passive loads (`../chat/session-load.service.ts`),
  startup and its history barrier (`../lifecycle/session-startup-history.ts`)
  and workflow finalization (`../lifecycle/session-workflow-finalizer.ts`).
- Wiring the cache to store clearing and permanent deletion:
  `../composition/session-core-services.ts`.

## Public surface

The capsule barrel exports the session data and provider resolver services, with
their factories, and `sessionRepository` from here. Stores are hydrated by a
hydrator from `createProviderHistoryHydrator`
(`session-provider-history-hydrator.ts`), one per session domain. PR receipt
lookup (`../delivery/session-pr-receipt.ts`) calls the two loaders directly,
reading only lines that contain its marker.

## Invariants

- Concurrent callers for the same session, provider, provider session ID,
  worktree and Codex account share one read and projection, and a caller never
  joins a read that already has a stale caller.
  `provider-history-transcript-loader.test.ts`,
  `../lifecycle/session-startup.history.test.ts`.
- A shared read stops only when every caller is stale, and a stopped read is
  never cached. `provider-history-transcript-loader.test.ts`.
- A cached projection is served only for the exact file identity (path, size,
  modification time, inode) seen both before and after its read, and each store
  receives its own top-level copy of every entry.
  `provider-history-transcript-cache.test.ts`, `session-history-file.test.ts`,
  `provider-history-transcript-loader.test.ts`.
- A cached projection does not expire while a store holds it; clearing the store
  starts its TTL, reopening holds it again, and permanent deletion drops it.
  `provider-history-transcript-cache.test.ts`,
  `../composition/session-services.composition.test.ts`.
- Codex tool backfill never replaces the transcript while the runtime is
  starting, running or stopping, including a phase entered during the read.
  `session-provider-history-hydrator.test.ts`.

## Map

- `session-history-loader.service.ts`,
  `codex-session-history-loader.service.ts`: find and parse each provider's
  history file, restoring prompt images through `history-image-attachment.ts`.
- `session-history-jsonl-reader.ts`: the cooperative line reader both use.
- `session-history-file.ts`: the file identity a read observed.
- `provider-history-transcript-loader.ts`: the shared read and projection.
- `provider-history-transcript-cache.ts`: completed projections, bounded by
  entries, estimated bytes and a TTL.
- `session-provider-history-hydrator.ts`: applies a result through a domain's
  fences and backfills missing Codex tools.

## Decisions

- [Shared provider history reads exclude stale callers](../../../../../../docs/decisions/2026-11-13-shared-provider-history-reads-exclude-stale-callers.md)
