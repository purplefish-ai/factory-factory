# Chat message flow

This note has moved. Read the
[chat feature guide](../src/client/features/chat/AGENTS.md) for the client's
ownership, invariants and map, and the records it links in
[decisions](decisions/) for the reasons. The tests the guide names describe the
behaviour.

The server side (what the session capsule sends, replays and publishes, and how
the WebSocket transport delivers it) has no guide yet. Its rules, hazards and
ownership statements are held below until those areas are migrated; their
behaviour is in the tests beside `src/backend/services/session/` and
`src/backend/routers/websocket/`.

This page remains while the section below holds entries; delete it when they are
gone.

## Held for other guides

Rules, hazards and reasons from the old note that belong to another area. Each
entry quotes only the sentences it needs from the paragraph named after it,
verbatim, with `[…]` where sentences between them are left out, and has not been
checked against the code. The migration that creates the named area's guide
checks the entry, moves what holds there and deletes the entry here. Paragraph
numbers are the rows of the disposition table in pull request #3226.

```mermaid
flowchart TD
    UI[Chat composer] -->|queue_message over WebSocket| Handler[WebSocket chat message router]
    Handler --> Command[Socket-free execution command]
    Command --> Store[SessionDomainService: queue and transcript]
    Command --> Dispatcher[SessionDispatchService]
    Dispatcher --> Store
    Dispatcher -->|dispatch through session lifecycle| Runtime[AcpRuntimeManager]
    Runtime -->|session/prompt| Provider[Claude or Codex ACP adapter]
    Provider -->|session/update| Processor[AcpEventProcessor and AcpEventTranslator]
    Processor --> Store
    Store --> Publisher[SessionPublisher]
    Publisher --> Bus[SessionEventBus]
    Bus --> Registry[ChatConnectionRegistry]
    Registry -->|WebSocket| Transport[useChatTransport]
    Transport --> Reducer[chatReducer]
```

Old paragraph 4. For the session capsule guide's map; the client end is in the
chat feature guide.

> `chat-message-router.ts` composes the command registry at the WebSocket
> boundary from explicit application capabilities. Commands accept plain data
> and return typed outcomes; they receive no sockets.

Old paragraph 5. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Session composition configures one `SessionDispatchService`. The dispatcher
> owns queue execution, concurrent-dispatch tokens, busy-turn retry timers and
> attempts, and manual resume. `SessionLifecycleGate` owns lifecycle
> generations; the dispatcher applies its generation checks when validating
> dispatch eligibility and starting the runtime through injected capabilities.
> The queued message stays visible until dispatch is ready, so refreshing during
> startup does not remove it from the queue.

Old paragraph 5. For the session capsule guide.

> The dispatcher uses notification and background-delivery capabilities for
> claims, preparation, validation, and completion. Those services retain claim
> and delivery authority; GitHub trigger interpretation remains outside queue
> execution. Workspace initialization, workspace notifications, PR delivery,
> lifecycle queue recovery, and prompt completion use the same dispatcher
> directly through their dispatch capabilities. Queue reset and manual resume
> callbacks also target that instance; the chat router has no dispatch facade.
> Application composition binds workspace startup, READY retries, child
> initialization, and live notification delivery to the supplied graph's
> dispatcher. Direct legacy orchestrator calls retain an explicit default
> dispatcher binding.

Old paragraph 6. For the session capsule guide.

> `AcpEventProcessor` translates provider updates with `AcpEventTranslator`,
> stores transcript changes, and emits session deltas. Streaming text
> accumulates under a stable message order so the client updates the existing
> message. Runtime and permission events update session state through their
> respective handlers.

Old paragraph 7. For the session capsule guide.

> `SessionEventBus` is the transport-free outbound surface. `SessionPublisher`
> wraps incremental events in `session_delta`; `ChatConnectionRegistry` owns
> socket subscriptions, serialization, delivery, and logging of payloads that
> reach a client. The registry also supplies viewer counts to the domain through
> the bus.

Old paragraph 8. For the session capsule guide and a WebSocket router guide.

> `ChatEventForwarderService` handles workspace completion notifications and
> pending-request access. Agent stream translation belongs to the ACP processor;
> it does not attach legacy `ClaudeClient` listeners.

Old paragraph 9. For the session capsule guide.

> The `set_model`, `set_config_option`, `set_thinking_budget`, and
> `permission_response` handlers take a plain `SessionCommandContext` and typed
> message. Their injected capabilities perform session operations; their
> `SessionCommandOutcome` describes requester replies. These leaf handlers
> receive no WebSocket and do not serialize frames.

Old paragraph 10. For the session capsule guide.

> `chat-command-adapter.ts` owns requester serialization and existing error
> copy. It silently ignores `message_not_queued` outcomes so repeated removal
> clicks or queue dispatch races do not add errors to the transcript.

Old paragraph 11. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> The session configuration service serializes each configuration write through
> provider completion, persistence and state publication. When a live configured
> handle supplies confirmed options, a rejected change emits its configuration
> correction through `SessionDomainService.emitDelta` before releasing that
> write's queue slot. This prevents a delayed rollback from overwriting a newer
> successful choice. Inactive or unavailable-session failures can return an
> error without a configuration correction. Correction delivery is independent
> of the requester's connection; only the requester receives the error and its
> optional request correlation ID. Explicit model capabilities replies are
> requester-only. Permission completion and matching-request cleanup remain
> owned by the permission service.

Old paragraph 11. For the session capsule guide.

> The `start`, `stop`, `user_input`, `queue_message`, `remove_queued_message`,
> and `resume_queued_messages` commands use the same plain context and typed
> outcomes. Their lifecycle, domain, background-delivery and dispatcher
> capabilities are supplied by the transport composition from the application
> graph. Queue acceptance, rejection, and cancellation stay on the session-wide
> event channel; only requester errors are returned to the adapter.

Old paragraph 12. For the session capsule guide.

> Direct `user_input` still sends without waiting for a provider turn or
> background resume persistence. Start and queue acceptance also trigger
> background resume without awaiting it. Explicit queue resume awaits
> persistence and rechecks its captured generation before enabling manual
> dispatch. Stop awaits termination, clears pending interaction, resets dispatch
> state, and then retries the queue. The lifecycle and background-delivery
> owners retain generation and PR pause policy; commands coordinate those
> capabilities without taking ownership.

Old paragraph 13. For the session capsule guide.

> The load command uses explicit preparation, synchronous replay capture, and
> completion through `SessionLoadService`. Its preparation and replay are plain
> data. The transport adapter owns replay framing and requester error delivery.

Old paragraph 14. For the session capsule guide and a WebSocket router guide.

> Registering a chat WebSocket does not hydrate history. The client explicitly
> sends `load_session`, whose transport adapter runs these application stages:

Old paragraph 15. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> 1. `prepareLoad` reads the `AgentSession`, hydrates provider history, and
>    merges durable lifecycle events. History fences, transcript writes,
>    hydration flags, and retry cooldowns use the same application domain that
>    supplies replay.
> 2. `captureReplay` synchronously reads the current runtime, recovers
>    interrupted tool calls for stopped sessions, and captures domain replay
>    data. The adapter immediately publishes the `session_replay_batch` envelope
>    on the existing session event bus, preserving `loadRequestId` and broadcast
>    recipient scope. Capture and publication do not yield, so a queued live
>    update cannot precede a stale replay.
> 3. `completeLoad` updates the runtime and resolves one configuration
>    projection. It synchronously finalizes that read against the current live
>    handle, publishes capabilities then nonempty configuration options without
>    yielding, then awaits and publishes cached slash commands. It consumes and
>    dispatches any stored initial message through that application's dispatcher
>    only after commands.

Old paragraph 16. For the session capsule guide and a WebSocket router guide.

> The configuration owner performs at most one catalog lookup per completion,
> including failed discovery, and rechecks stored selection after discovery.
> Successful catalog reads still share their existing cache. A live handle owns
> capabilities; for compatibility, an empty live handle still permits stored
> fallback options. Passive reads never persist a catalog selection. If a
> prepared live handle retires before publication, another read supplies the
> durable fallback. Every retry is finalized again synchronously and reuses the
> same catalog attempt. Repeated runtime retirement fails before configuration
> publication or initial activation.

Old paragraph 17. For the session capsule guide.

> Socket subscriptions, serialization, safe delivery, and disconnected-viewer
> cleanup remain owned by the transport. A closed or throwing requester does not
> skip application completion or another viewer's load updates. Concurrent loads
> retain their own request IDs and consume stored initial text once.

Old paragraph 18. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Chat and snapshot delivery use a stateful send policy. A viewer that exceeds 1
> MiB of accumulated outgoing backlog is retired with close code 1013, then
> terminated after five seconds if its close handshake has not completed. No
> further state is sent on that connection, even if the buffer later drains.
> Synchronous and asynchronous write failures also retire that viewer. Other
> viewers and application work continue; reconnect runs the existing correlated
> load/replay or current full-snapshot path.

Old paragraph 19. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> A full snapshot, session snapshot, or legacy replay batch can exceed the
> ordinary backlog budget on an empty connection. `WEBSOCKET_MAX_FRAME_BYTES`,
> read through `configService`, sets its absolute UTF-8 frame ceiling: **32 MiB
> by default** (33554432 bytes). Valid overrides are integer byte counts from 1
> MiB through 256 MiB, inclusive; missing or invalid values use the default.
> This permits realistic large history/project baselines while bounding queued
> state per viewer. Serialization still happens before measurement, so the limit
> bounds outgoing frames rather than the cost of constructing authoritative
> state.

Old paragraph 20. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Load correlation IDs are bounded to 128 UTF-16 code units at admission so even
> escaped identifiers fit the small error envelope without losing correlation.
> Existing persisted/imported project IDs remain valid; snapshot errors omit an
> overlong project ID and use the current connection scope for HTTP fallback. An
> excessive replay returns a small `error` with code 413 and the requesting
> `loadRequestId`; the client ends loading, cancels automatic load retries and
> keeps unhydrated controls disabled. Other already-hydrated viewers keep their
> live updates. An excessive project baseline returns `snapshot_error` with
> `FRAME_TOO_LARGE`; the client shows its explanation and refreshes via the
> existing HTTP fallback. Both keep the socket open and suppress subsequent
> baseline-dependent updates to the viewer missing its baseline. Independent
> command replies and workspace notifications remain available. Only a baseline
> accepted by that viewer can release the guard. They do not reconnect to the
> same rejected state. […] A successfully accepted baseline releases that guard.

Old paragraph 21. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Replay retains the responsive history loading and 128 KiB wire chunks. Framing
> serializes each replay event once, assembles event-frame JSON from those
> strings and publishes each frame with its JSON; the transport sends that JSON
> instead of serializing the frame again. Framing and publication remain one
> synchronous pass. Chunk envelopes carry the bounded load correlation ID,
> including the byte-fragment fallback for unusually large replay metadata. The
> configured budget also bounds the logical replay; the existing 128 MiB replay
> assembly ceiling remains an absolute upper bound. A viewer queues one bounded
> replay sequence, writes one chunk at a time as local write callbacks finish,
> and holds at most 1 MiB of dependent updates until the complete baseline is
> written. Serialized replay storage is bounded by twice its declared source
> size plus 1 KiB per bounded chunk for base64/envelope overhead. Independent
> command replies and notifications remain available. A retry of the same
> pending load reuses its sequence; a newer distinct request explicitly
> supersedes and settles the older request with a correlated 409 error. Neither
> coalesced retries nor failed writes create OUT_TO_CLIENT records. These
> records describe successful local socket writes, not application-level peer
> receipts.

Old paragraph 22. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> A large full frame's write callback releases its allowance. Completion
> metadata and subsequent deltas share an additional 1 MiB budget. Close,
> successful flush, and retirement clean up listeners, pending queues and
> termination timers. Snapshot deltas still wait for the full baseline to be
> admitted, and replay keeps its existing request IDs, message identities and
> ordering.

Old paragraph 23. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Passive loading does not initialize an ACP runtime. A stored initial message
> may subsequently be enqueued and dispatched through the normal message path.

Old paragraph 24. For the session capsule guide.

> Replay reconstructs the renderer's transcript window, queued messages,
> runtime, pending interactive request, and retained recent rejections.
> `SessionPublisher` also supports `session_snapshot`; loading is not split into
> an initial snapshot protocol and a separate reconnect protocol.
> `loadRequestId` associates responses with the client's load request. Snapshots
> for a session nobody is viewing are not built, since a viewer that arrives
> later hydrates through `load_session`; load replies are always sent.

Old paragraph 25. For the session capsule guide.

> Provider history comes from the Claude or Codex history loader selected by the
> session's provider and identity. Concurrent loads, retries and an overlapping
> startup share one read, and reopening an idle session can reuse its cached
> projection while the history file is unchanged and the entry is retained; see
> [agent runtime](architecture/agent-runtime.md). Codex tool-history backfill
> defers transcript renumbering while a session is starting, running, or
> stopping, including turns that begin during the history read. This preserves
> the message orders used by live text deltas. A later idle load can recover the
> missing tools.

Old paragraph 26. For the session capsule guide.

> In-memory pending requests can survive a viewer reconnect while the session
> exists; they are not a durable permission request that can be resumed after a
> server restart.

Old paragraph 27. For the session capsule guide.

> Full snapshots remain for explicit `emitSessionSnapshot` calls, process exit,
> clearing queued work, provider-history reset, transcript removal, injected
> replay messages, and PR-delivery queue changes that also rewrite the
> transcript (enqueueing over a previous outcome or cancelling a queued update).
> Snapshots for a session nobody is viewing are still skipped.

Old paragraph 31. For the session capsule guide.

> Backend senders are typed against `WebSocketMessage`; direct requester replies
> go through `serializeChatFrame`.

Old paragraph 32. For a WebSocket router guide
(`src/backend/routers/websocket/`).

> Questions and permissions are stored in
> `SessionStore.pendingInteractiveRequest` and included in replay. The
> permission service resolves responses and clears the matching pending request
> only after successful resolution, including for callers outside WebSocket
> handlers. Request IDs ensure an older response cannot clear a newer request;
> unresolved responses leave pending state unchanged.

Old paragraph 38. For the session capsule guide.

> Task creation also uses native content sizing, capped at 240 pixels. Browsers
> without native content sizing use one resize after the draft commits and
> restore internal scrolling after measurement; repeated height resets otherwise
> cause jumps once that cap is reached.

Old paragraph 48. For the Kanban feature guide (`src/client/features/kanban/`).

> The compatible archive reader is `ClosedSessionReadTranscriptSchema`
> (`closed-session-transcript-schema.ts`), built on `ArchivedJsonRecordSchema`;
> […] Preserving opaque legacy rows is the reader DTO's job; rendering their
> fallback happens in `closed-session-transcript-items.ts`.

Old paragraph 56. For the session capsule guide (closed-session archive).

> | Concern                                               | Source                                                                                                                                                                                                        |
> | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Queue, transcript, runtime snapshot, pending requests | [SessionDomainService](../src/backend/services/session/service/session-domain.service.ts) and its `store/` collaborators                                                                                      |
> | Provider event translation                            | [AcpEventProcessor](../src/backend/services/session/service/events/acp-event-processor.ts)                                                                                                                    |
> | History hydration and replay                          | [SessionLoadService](../src/backend/services/session/service/chat/session-load.service.ts) and [provider history hydrator](../src/backend/services/session/service/data/session-provider-history-hydrator.ts) |
> | Outbound event envelopes                              | [SessionPublisher](../src/backend/services/session/service/store/session-publisher.ts)                                                                                                                        |
> | WebSocket subscriptions and delivery                  | [ChatConnectionRegistry](../src/backend/routers/websocket/chat-connection-registry.ts)                                                                                                                        |
> | Persisted provider identity and lifecycle history     | `AgentSession` and `SessionLifecycleEvent` in [Prisma schema](../prisma/schema.prisma)                                                                                                                        |

Old paragraph 59, every row but the client's. For the session capsule guide and
a WebSocket router guide.
