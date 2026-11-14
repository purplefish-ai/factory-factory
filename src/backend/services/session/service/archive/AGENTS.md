# Closed-session archive module

Archives a closed session: a transcript file under the worktree's
`.context/closed-sessions/` and a `ClosedSession` row, and reads both back. The
[capsule guide](../../AGENTS.md) covers the capsule. Bare file names below are
in this directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

The module owns the archive's file format, writing it, and the two reads:
provider identity from the file's header and the full body. It does not own:

- When a session may be closed, and the close itself:
  `../lifecycle/session-workflow-finalizer.ts`, using the observed
  empty-conversation proof kept by `../acp/acp-runtime-supervisor.ts`. Archiving
  the previous transcript when a provider identity rolls over:
  `../lifecycle/session-provider-identity.service.ts`.
- PR receipt lookup in archived history: `../delivery/session-pr-receipt.ts`.
- The compatible reader schema, which keeps legacy rows, unknown fields and own
  reserved keys:
  `src/shared/acp-protocol/protocol/closed-session-transcript-schema.ts`.
- The procedures `getTranscript` and `getTranscriptJson`:
  `src/backend/trpc/closed-sessions.trpc.ts`.
- The archive view and its raw-JSON fallback rows:
  `src/client/features/workspace/closed-session-transcript-view.tsx` and
  `src/client/features/workspace/closed-session-transcript-items.ts`.

## Public surface

The capsule barrel exports the types `ClosedSessionTranscript` and
`ArchivedProviderIdentity`. The two reads reach callers through
`sessionDataService` (`readClosedSessionProviderIdentity`,
`readClosedSessionTranscript`); the close goes through the lifecycle.

## Invariants

- Closing a provider-backed session archives it only with retained provider
  messages, a confirmed history file load (even an empty one), or this runtime's
  proof that it created the provider conversation and sent it no prompt; when
  provider history is unavailable and none of these holds, the close throws and
  archives nothing. `../lifecycle/session-workflow-finalizer.history.test.ts`.
- That proof is scoped to the exact provider identity and is revoked before any
  prompt is attempted, on conversation activity, a new runtime, a failed
  startup, shutdown and permanent deletion.
  `../acp/acp-runtime-manager.empty-history.test.ts`,
  `../composition/session-services.composition.test.ts`.
- Both reads take the transcript path from the row, reject absolute paths, and
  require it to stay inside the workspace's worktree both as written and after
  resolving symlinks. `closed-session-reader.test.ts`.
- A provider identity is returned only from a header whose session and provider
  match the row, and whose workspace matches when present.
  `closed-session-reader.test.ts`.
- A malformed body fails the full read with an application error even when the
  header still yields an identity. `closed-session-reader.test.ts`.
- An archived identity only selects which provider history to search: delivery
  is proven by a user message carrying the marker, and a known live Codex
  account must equal the archived one. `../delivery/session-pr-receipt.test.ts`.

## Map

- `closed-session-persistence.service.ts`: writes the file and the row.
- `closed-session-transcript-header.ts`: reads the header from the first 64 KiB
  of a pretty-printed file, falling back to parsing the whole file.
- `closed-session-reader.ts`: path containment, identity binding and both reads.

## Decisions

- [Closed-session transcripts reach the client as JSON text](../../../../../../docs/decisions/2026-11-13-closed-session-transcripts-reach-the-client-as-json-text.md)
