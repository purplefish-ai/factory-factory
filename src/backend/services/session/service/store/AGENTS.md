# Session store module

Each session's in-memory state behind `SessionDomainService`: the transcript,
the message queue, the runtime snapshot and the pending interactive request, the
snapshots and deltas that publish them, and the replay a load sends. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. Bare file names below are in this directory;
paths that start with `src/` are from the repository root.

## Owns, and does not own

The module owns the per-session stores and their registry, how long an idle
store outlives its last viewer, what a runtime snapshot keeps, which change
publishes a snapshot and which a smaller delta, replay events, the provider
history fences and resume fences that outlive store eviction, and the
slash-command cache. It does not own:

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

- A hydrated store whose last viewer left without a running runtime is kept for
  10 minutes, at most 12 at once (the oldest is cleared early). A load ends the
  countdown. A store in use when it ends (a viewer, a running runtime, queued or
  dispatching work) is not cleared: it counts down again, or, pushed out by the
  cap, is left to the owner of that use. Clearing the session, clearing all
  sessions and the shutdown step end it without leaving a timer.
  `session-store-retention.test.ts`,
  `src/backend/routers/websocket/chat-load.handler.test.ts`,
  `src/backend/application-shutdown.test.ts`
  ([why](../../../../../../docs/decisions/2026-11-23-idle-session-stores-outlive-their-last-viewer.md)).
- A kept store hydrated from a provider history file is replayed only if no
  runtime is alive and the file's identity is unchanged; otherwise it is
  discarded before hydration, and a concurrent load waits for the check.
  `../chat/session-load.service.test.ts`,
  `src/backend/routers/websocket/chat-load.handler.test.ts`.
- A runtime snapshot keeps background work only while its process is alive; an
  idle or error transition drops the cached work unless fresh work is supplied.
  `session-runtime-machine.test.ts`.
- A runtime transition that changes nothing but the timestamp stores it without
  publishing a runtime delta. `session-runtime-machine.test.ts`.
- Every runtime write is counted by its (phase, process state, activity)
  combination and its writer, and never rejected or changed. A combination the
  table in `session-runtime-combinations.ts` marks meaningless or undecided, or
  does not list, is logged at most once per combination and writer every 10
  minutes. The counts are in `/health/all` and in a
  `session runtime combinations` log line, written when they changed at shutdown
  and by the first write 30 minutes after the last one. The table is evidence
  for a runtime redesign decision, not a rule.
  `session-runtime-combinations.test.ts`.
- Live provider notices keep the same transcript ID and ignore stale revisions.
  `../events/acp-event-processor.notices.test.ts`.
- A human submission ID identifies one payload while it is queued, preparing for
  dispatch, or committed in the session store. Retries acknowledge its existing
  state. If the original is still queued when persistence fails, admission
  removes it and publishes its recoverable draft in one rejection.
  `../chat/chat-message-handlers/handlers/queue-message.admission.test.ts`.
- Replay, queue deltas and snapshots include a claimed batch through provider
  configuration. Dispatch cannot select a claimed message again.
  `../dispatch/session-dispatch-batch.test.ts`.
- A message moving from the queue into the transcript is never published as
  absent from both: the delta that removes it also carries its transcript entry,
  as a `transcript_message_committed` delta with the remaining queue or a
  dispatched state with the user message. `session-domain.state-deltas.test.ts`,
  `../dispatch/session-dispatch.service.test.ts`.
- A load rescans a worktree's slash commands unless the worktree resolves to the
  same root and no directory the last scan listed or command file it read has
  changed (inode, size, modification or change time), so an added, edited or
  removed command, or a link target that appears, shows on the next load. A scan
  whose newest change is under two seconds old is not reused.
  `slash-command-workspace-cache.test.ts`.

## Map

- `session-domain.service.ts`: `SessionDomainService`, the facade every other
  module uses.
- `session-store-registry.ts`, `session-store.types.ts`: the stores. Only
  `SessionStoreRegistry.getOrCreate` creates one, and a session's store is
  cleared through `SessionDomainService.clearSession` or `clearAllSessions`,
  which emit `session_cleared` (a store kept only for recent rejections expires
  on its own). `session-store-retention.ts`: keeping idle stores after their
  last viewer; `session-history-fences.ts`: provider history fences.
- `session-transcript.ts`, `session-transcript-page.ts`,
  `session-tool-use-index.ts`, `session-tool-call-recovery.ts`: the transcript,
  its pages and tool calls; `session-local-transcript.ts` and
  `session-lifecycle-transcript.ts` place status and lifecycle cards.
- `session-queue.ts`: the queue and the pending interactive request;
  `session-submission.ts`: matching human retries to their retained outcomes;
  `session-pr-update.ts`: PR update outcomes.
- `session-runtime-machine.ts`: runtime snapshots, including the initial launch;
  `session-process-exit.ts`: a process exit; `session-runtime-combinations.ts`:
  the table of runtime combinations and their counts.
- `session-publisher.ts`: snapshots and deltas; `session-replay-builder.ts`: the
  replay a load sends.
- `session-resume-fence.ts`: resume authorization that survives eviction.
- `slash-command-cache.service.ts`, `slash-command-disk-scanner.ts`: slash
  commands read from disk, and the per-worktree scan cache.
