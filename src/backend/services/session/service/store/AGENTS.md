# Session store module

Each session's in-memory state behind `SessionDomainService`: the transcript,
the message queue, the runtime snapshot and the pending interactive request, the
snapshots and deltas that publish them, and the replay a load sends. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. Bare file names below are in this directory;
paths that start with `src/` are from the repository root.

## Owns, and does not own

The module owns the per-session stores and their registry, what a runtime
snapshot keeps, which change publishes a snapshot and which a smaller delta,
replay events, resume fences that outlive store eviction, and the slash-command
cache. It does not own:

- Socket subscriptions and delivery to viewers:
  `src/backend/routers/websocket/`, reached through `sessionEventBus`
  (`../event-bus/`).
- Wire schemas: `src/shared/acp-protocol/`.
- Translating provider updates into transcript entries and runtime state:
  `../events/`. The background work a snapshot carries comes from the native
  session tracker in `../acp/`.
- When a message leaves the queue: `../dispatch/`.
- Durable lifecycle events and provider history: `../lifecycle/` and `../data/`;
  the store only merges them into the transcript.

## Public surface

The capsule barrel exports the singleton `sessionDomainService` and the class
`SessionDomainService`. Other modules import `session-domain.service.ts`
directly.

## Invariants

- A runtime snapshot keeps background work only while its process is alive; an
  idle or error transition drops the cached work unless fresh work is supplied.
  `session-runtime-machine.test.ts`.
- A runtime transition that changes nothing but the timestamp stores it without
  publishing a runtime delta. `session-runtime-machine.test.ts`.
- A message leaving the queue is never published as absent from both the queue
  and the transcript: the delta that removes it also carries its transcript
  entry, as a `transcript_message_committed` delta with the remaining queue or a
  dispatched state with the user message. `session-domain.state-deltas.test.ts`,
  `../dispatch/session-dispatch.service.test.ts`.

## Map

- `session-domain.service.ts`: `SessionDomainService`, the facade every other
  module uses.
- `session-store-registry.ts`, `session-store.types.ts`: the stores.
- `session-transcript.ts`, `session-transcript-page.ts`,
  `session-tool-use-index.ts`, `session-tool-call-recovery.ts`: the transcript,
  its pages and tool calls; `session-local-transcript.ts` and
  `session-lifecycle-transcript.ts` place status and lifecycle cards.
- `session-queue.ts`: the queue and the pending interactive request;
  `session-pr-update.ts`: PR update outcomes.
- `session-runtime-machine.ts`: runtime snapshots, including the initial launch;
  `session-process-exit.ts`: a process exit.
- `session-publisher.ts`: snapshots and deltas; `session-replay-builder.ts`: the
  replay a load sends.
- `session-resume-fence.ts`: resume authorization that survives eviction.
- `slash-command-cache.service.ts`, `slash-command-disk-scanner.ts`: slash
  commands read from disk.
