# Agent Runtime

The paragraphs that opened this note, the section "Chat tool previews", and the
opening of "ACP runtime" with its "Provider and model selection", "Launch
permissions, thinking, and Plan", "Permission and configuration readiness",
"Activity and prompt dispatch", "Codex accounts" and "Usage and compaction" have
been migrated; the tool preview rules are asserted by the tests in
`src/client/features/chat/agent-activity/tool-renderers/`. Ownership, public
surface, invariants and file maps are in the guides beside the code:
[application update capsule](../../src/backend/services/application-update/AGENTS.md),
[Codex accounts capsule](../../src/backend/services/codex-accounts/AGENTS.md),
[CLI](../../src/cli/AGENTS.md),
[session selection](../../src/client/features/session-selection/AGENTS.md),
[chat usage control](../../src/client/features/chat/usage-stats/AGENTS.md),
[session capsule](../../src/backend/services/session/AGENTS.md) and its
[data](../../src/backend/services/session/service/data/AGENTS.md),
[archive](../../src/backend/services/session/service/archive/AGENTS.md),
[acp](../../src/backend/services/session/service/acp/AGENTS.md),
[config](../../src/backend/services/session/service/config/AGENTS.md),
[dispatch](../../src/backend/services/session/service/dispatch/AGENTS.md),
[events](../../src/backend/services/session/service/events/AGENTS.md),
[store](../../src/backend/services/session/service/store/AGENTS.md) and
[providers](../../src/backend/services/session/service/providers/AGENTS.md)
module guides. The reasons are in the `2026-11-13-*` records in
[decisions](../decisions/), and the tests those guides name describe the
behaviour. The sections below have not been migrated yet.

## ACP runtime

### Failed provider resume

An active session whose provider cannot load its stored identity explicitly
reports `resume_fallback` (load failed or load unsupported). Browsing continues
to fail without creating a replacement. Startup keeps the replacement runtime
unavailable until the lifecycle owner reconciles it.

A Codex `thread_active_writer` load failure preserves the stored conversation
and reports that its other client must release it before retrying; it never
creates a replacement. Development backends running alongside the main backend
must use separate `BASE_DIR`/`DATABASE_PATH` values to avoid sharing session
ownership. After a legitimate fallback commits, startup accepts the replacement
identity's durable native access and reasoning snapshot.

The lifecycle owner archives the currently observed transcript through the
existing closed-session history before clearing provider messages from the
active chat. Durable stop evidence stays with the AgentSession; provider-owned
history files are never modified or deleted. With no observed messages, no
archive is created. The replacement starts a fresh provider conversation, and
does not have the old conversation as model context.

A dedicated compare-and-set operation changes the existing AgentSession's
provider identity, matching ACP config snapshot, and `providerIdentityRollovers`
audit together. It matches the old identity, metadata, and update timestamp;
ordinary identity writes still enforce immutability. The audit records the
runtime incarnation, reason, old/new identities, and archived message count. An
archive or reconciliation failure aborts startup and terminates the candidate,
preserving the old active transcript and identity. A stop racing a successful
commit leaves the new durable identity available for the next restart. An
archive created before a cancelled or failed commit remains available as a
retained copy.

Pending configuration notifications carry an internal source capability to the
configuration owner while public runtime lookup still hides their candidate. The
source remains valid after creation clears. Its existing stop-generation fence
rejects observations during a stop attempt, and exit or replacement invalidates
it, including through the guarded snapshot write. If stopping fails and retains
the same live runtime, observations may resume once that stop attempt clears.

Runtime incarnation/stop fences reject stale repair callbacks. A process that
has exited by code or signal fails the liveness fence, including when an
external signal kills a candidate during identity reconciliation. Failed-load
replay is discarded before `newSession`; replacement updates stay buffered until
repair succeeds. History hydration ignores reads started under an older
identity, even when they finish after rollover, and retry cooldowns reset for
the new identity. After backend restart, the reconciled column is the
authoritative history ID.

Startup buffers at most 10,000 ACP events while provider creation and identity
persistence are pending. During provider history load, transcript events already
covered by hydrated history are suppressed before entering this buffer. Raw
logging and native work tracking still receive the replay, while configuration,
commands, usage, plans, notices and subagent state continue through startup.
Suppressed transcript updates still maintain translator bookkeeping, including
compaction identities. The tracker's replay-end marker ends early filtering
before the load response when supported; otherwise load completion ends it.
Native child replay retains all transcript updates within its existing limits
but emits only creation/completion invalidations until replay finishes, avoiding
one buffered invalidation per child output chunk. Live invalidations continue
normally afterward. Suppression ends before a failed load starts a replacement
conversation. Overflow cancels startup and terminates its candidate; it never
installs a runtime with a silently truncated transcript. Rollover fencing
rejects further reconciliation after overflow, and a later startup can retry.

### Session prompts

ACP init/load uses the provider's built-in instructions; Factory Factory does
not supply a custom system prompt. Task prompts are sent as ordinary session
messages:

- Issue starts: `src/shared/issue-start-prompt.ts`, shared with the editable UI
  preview. It asks the agent to fetch and address the linked GitHub or Linear
  issue, then create a PR with a closing reference. The concise handoff quotes
  the URL and marks fetched content as untrusted; issue bodies and detailed
  workflow instructions are not embedded. Repository guidance defines
  implementation and verification. Backend fallback prompts use the stored issue
  URL (or derive a GitHub URL from repository metadata), without fetching issue
  content. The read-only `get_linear_issue` workspace MCP tool fetches the
  linked Linear issue on demand through `workspace.get` and `linear.getIssue`,
  using backend-held project credentials. It accepts no workspace/project/issue
  overrides and returns only issue fields, treating provider text as untrusted
  data.
- PR updates: `src/backend/prompts/pr-event.ts` renders bounded PR facts with
  maintenance instructions only when an attached PR has actionable events.
  Delivery uses the source-aware session queue and strict provider resume; see
  [PR updates](pull-requests.md).
- Quick actions: `prompts/quick-actions/` (see below).
- Child workspace starts append `buildChildWorkspaceContext` through workspace
  initialization. Workspace metadata generation runs separately from working
  sessions; it never injects branch-renaming prompts into the conversation. See
  [workspace lifecycle guide](../../src/backend/orchestration/workspace-lifecycle/AGENTS.md).

Legacy workflow templates and unused system-prompt construction have been
removed. Stored workflow IDs still select session behavior and permissions. Keep
prompts focused on outcomes and actual automation contracts, and defer
repository-specific tools and verification commands to repository guidance.

Claude ACP retains its bare Claude Code preset and existing prompt snapshot
behavior. Before introducing custom system-prompt metadata, revisit the SDK's
custom/append snapshot semantics. See the 2026-09-09 remaining-dependencies
upgrade plan at tag `docs-archive-2026-11`.

Scheduled Codex tasks retain their YOLO access preset and scheduled Claude tasks
retain their configured access preset. MAIN PR updates inherit their main
conversation’s configuration. DEDICATED updates use the workspace’s provider
selection and normal user model defaults; later updates reuse that dedicated
conversation’s saved configuration. PR updates do not use a workflow-specific
permission preset.

Chat command composition belongs to `routers/websocket/chat-message-router.ts`;
application commands receive plain contexts and typed outcomes. Loading prepares
history asynchronously, captures current runtime/recovery/replay synchronously,
then publishes replay at the transport boundary without yielding. Application
completion owns runtime updates, capabilities, options, slash commands, and
initial-message activation in that order. Capabilities and options share one
configuration resolution per completion and publish consecutively after a
synchronous live-handle recheck. Load activation uses the supplied application
graph's dispatcher. See [chat message flow](../chat-message-flow.md) for
reconnect, recipient, and failure contracts.

## Event creation ownership

The durable event launch consumer composes `createEventWorkspaceOnce` and
`createEventSessionOnce` with reserved IDs from an admitted event run. They
create their entity and retained launch origin in one transaction. Workspace
origins survive workspace, run and project removal; session origins survive
session and workspace removal. A retained origin without its live entity blocks
recreation, including deletion before run linkage. Archived workspaces and
projects also block creation/reuse. Generic interactive, child and periodic
creation keeps its existing behavior.

Deleting an automation, which is refused while any of its runs is unfinished,
removes its runs but not these origins. The owner's fence read then returns
null, and the session authority treats such a session as ordinary: messages,
startup and stops proceed as for a finished event session, with no stop evidence
to record. Initial delivery, retry and workspace setup retry stay blocked,
because there is no run to authorize them.

The agent-definition owner exposes `readEventExecutionBinding` and
`freezeEventExecution`. Freeze checks the current worker/attempt, lease,
reserved IDs and PENDING delivery identity, then stores immutable effective
execution without changing admitted snapshots. The original reserved message ID
stays fixed; a later explicit retry can rotate the delivery's message ID and
send-attempt ID. Generation checks fence earlier callers.

New event runs freeze access from the saved workspace permission preset for both
providers. Non-interactive execution does not grant extra permissions; explicit
YOLO remains honored. Recovery reuses the frozen access intent rather than
reading newer defaults. Startup validates that the provider supports and applies
that intent, including Claude’s `auto` / `acceptEdits` compatibility.

Launch orchestration selects a Codex account under `withAccountReservation`,
freezes its ID before session insertion, and uses that same ID on recovery or
fails. Session creation validates that exact account via the application graph's
account service without selecting Auto or entering a second reservation.
Disabled, missing or unauthenticated frozen accounts do not fall back. Origins
store account IDs and a strict versioned execution intent, never credentials.
The first session insert checks the run's frozen execution and reserved
workspace/session/project identity in its transaction through a narrow read-only
integrity check. Session reuse compares that original intent rather than mutable
model/launch metadata. Initial dispatch pins the origin's settings even if a
human has changed ordinary conversation settings.

Event sessions use `event-agent` and explicit `non_interactive` intent, with
ratchet disabled at workspace creation. They do not inherit periodic Codex YOLO
permissions. These APIs neither initialize a provider nor dispatch a prompt; the
consumer composes strict setup/restart and observed initial dispatch around
them. Enabling a saved agent validates native capability on the server and
persists that intent; admission applies the same native effort normalization
(see [its guide](../../src/backend/services/agent-definition/AGENTS.md)).

The strict event workspace initializer shares the ordinary initializer's
per-workspace queue and worktree preparation. It validates the reserved session
and current run claim, then runs factory setup and project startup scripts
without the ordinary auto-message or first-IDLE-session path. Workspace writes
recheck the claim, lease, retained origins and live entities in the workspace
owner's transaction. An aborted or superseded initializer cannot publish a late
worktree or READY. The caller owns run linkage, lease renewal and eventual
initial dispatch; the initializer does not enqueue or send a prompt.

State publication revalidates the claim and emits the current row; unrelated
metadata writes cannot suppress READY, and notification failures cannot undo a
validated commit. Rejected observer promises are diagnosed without awaiting
observers or delaying later subscribers. A missing retained READY worktree
becomes FAILED under the same claim and path fence, preserving its path and
provenance for inspection. Recovery must not infer safe reinitialization from
PROVISIONING alone: the consumer preserves uncertain physical-work evidence and
retains capacity until current cleanup proof permits reset, or until a person
accepts an [unproven Abandon](#abandon-without-proof). Persisted PIDs never
grant process ownership.

Event setup has a fifteen-minute deadline. Uncancellable Git work remains owned
until it drains; timeout does not abandon its promise. Abort and script timeout
stop the current owned setup process group and distinguish confirmed cleanup
from UNKNOWN, including while output and PID writes drain after foreground exit.
Git's absence preflight does not reserve a path or prove ownership of later
physical work. A successful creation result permits safe cleanup only under a
fresh durable claim and caller ownership, checked independently of cancellation.
If creation rejects without that result, remaining disk or registration effects
are retained as UNKNOWN. CONFIRMED requires positive absence on disk and in Git
under the unchanged, available canonical base identity. Inspection failure is
UNKNOWN. Unknown cleanup forbids retry and automatic capacity release; only an
explicit [unproven Abandon](#abandon-without-proof) frees the slot. Ordinary
nonzero script exits still produce READY with a warning, and successful scripts
may retain background dev servers. Invalid configuration and execution errors
return explicit failures. Event initialization does not create an unattended
terminal or send a Linear status update; a user can open a terminal afterward.
Ordinary interactive, child and periodic initialization retain their policies.

## Session lifecycle ownership

`SessionLifecycleGate` owns domain startup/stop eligibility. Workspace
initialization reserves the initial session launch before publishing READY. The
runtime machine keeps idle startup and dispatch-preparation updates in
`starting` until work begins, startup/dispatch exits, or a stop or error ends
the launch. Ordinary queued follow-ups do not acquire this reservation. Runtime
reads preserve `starting` after a provider handle becomes live, until the
startup owner finishes configuration and persistence. A live process with no
prompt in flight is not sufficient evidence of idle during startup; dropping
that phase can move a newly ready workspace into Waiting before its first turn.
`AcpRuntimeSupervisor` is the sole mutable ACP runtime authority: it owns
subprocess handles, pending creation, incarnation filtering, exits, stops, and
quiescence. `AcpRuntimeManager` is the stable compatibility facade over the
supervisor and stateless ACP collaborators. Lifecycle coordinators continue to
own durable reconciliation and never manipulate runtime registries directly.
Runtime callbacks use `onRuntimeExit` and `onRuntimeError` events carrying the
supervisor's incarnation identity and current purpose. Exit events also carry
whether the stop was managed; coordinators consume this metadata directly,
including after a browsing runtime is promoted to active use.

Graceful server shutdown persists active sessions as `IDLE`, matching explicit
stops. PR delivery remains paused after an explicit stop until user
continuation. Runtime-managed exits without a shutdown reservation still use the
exit code to determine terminal status. Bulk shutdown retains its non-browse
lifecycle reservations through event recording and runtime shutdown, then
releases them on every exit path. Shutdown waits for a concurrent explicit
stop’s lifecycle write and suppresses a duplicate event only after durable
success. A failed write retries the same event identity, replacing its transient
banner if persistence recovers. Stops that suppress their own event still
receive shutdown history. The supervisor's closed shutdown admission remains in
effect after gate cleanup. Bulk shutdown does not run per-session stops, which
own queue retries, so the next shutdown step (`SessionDispatchService.shutdown`)
cancels pending retries, refuses new ones and waits for retries already
dispatching before the database closes.

Queue execution belongs to the single `SessionDispatchService` configured in
`session-services.ts`. Initialization, notification delivery, lifecycle queue
recovery, and prompt completion use its dispatch capability directly. The chat
registry's dispatch and manual-resume callbacks reach that same instance through
the transport-owned chat router. Lifecycle generation, delivery claim, and
transcript-commit ownership remain with their existing services.

At the next turn boundary, dispatch combines queued human messages and workspace
notifications in FIFO order into one provider prompt. A ready PR update batch
joins that prompt; a blocked PR update does not delay human messages. The latest
human message supplies the turn's settings. Slash commands remain standalone
turns so provider commands such as `/compact` retain their meaning.

Each message retains its own dispatch state and local transcript entry. A busy
provider restores the batch in order, while invalid attachments reject only
their own message. Cancelling a message during preparation retries the remaining
queue. Successful provider receipt commits the entire batch before separate
notification and PR acknowledgements; acknowledgement failures do not roll back
human messages. Provider history retains the combined human text and restores
trailing PR content as a compact update row.

The session capsule's `service/` directory is grouped by sub-domain. Imports
point up this table: code imports from its own row or earlier rows, never later
ones. The barrel `index.ts` sits below every row; the interceptor bridge is in
`composition/`.

| Directory                                                                       | Owns                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp/`, `inference/`, `event-bus/`, `store/`, `logging/`, `metadata/`, `voice/` | ACP runtimes; one-shot structured inference in a disposable process; event bus; in-memory session store, domain service, resume fence; trace logs; workspace metadata, event classifier; voice narration |
| `providers/`, `archive/`, `bridges/`, `errors/`, `attachments/`                 | Account-wide model catalogs and plan usage; closed-session transcripts; bridge interfaces (types only); provider error messages; attachment validation and prompt content                                |
| `data/`                                                                         | `SessionRepository`, stored launch settings and startup intent, provider history loading and hydration                                                                                                   |
| `config/`                                                                       | `SessionConfigService`, config commit authority and mutation queue, permission presets, launch options, startup configuration                                                                            |
| `event-agent/`                                                                  | `EventSessionAuthority`, event fences, event startup guards                                                                                                                                              |
| `delivery/`                                                                     | Notification and PR background delivery, PR receipts and discovery                                                                                                                                       |
| `events/`                                                                       | `AcpEventProcessor`, permission requests, sub-agent events, work state                                                                                                                                   |
| `lifecycle/`                                                                    | Gate, scope, startup, termination and runtime-exit coordinators, workflow finalizer, context, lifecycle events, the lifecycle facade                                                                     |
| `prompt/`                                                                       | `SessionService` prompt sends, child-workspace prompt context                                                                                                                                            |
| `dispatch/`                                                                     | Queue dispatch                                                                                                                                                                                           |
| `chat/`                                                                         | Chat commands, session load                                                                                                                                                                              |
| `composition/`                                                                  | Composition root (`session-core-services.ts`, `session-services.ts`)                                                                                                                                     |

`SessionConfigService` is a facade over four owners. `SessionConfigWriter`
accepts, persists and publishes native configuration writes, and every other
owner writes through it. `SessionConfigReader` projects live or stored
configuration. `SessionStartupConfiguration` applies launch intent to a new
runtime. `SessionConfigMutations` applies live and stopped-session edits.

Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility        | Owner                                              | Reconciliation point                                      |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Startup               | `SessionStartupCoordinator` (`lifecycle/`)         | Persisted `RUNNING` state                                 |
| Termination           | `SessionTerminationCoordinator` (`lifecycle/`)     | Persisted idle/stopped state                              |
| Runtime exit          | `SessionRuntimeExitCoordinator` (`lifecycle/`)     | Terminal status and unexpected-exit lifecycle history     |
| Notifications         | `SessionNotificationDeliveryService` (`delivery/`) | Transcript plus delivered evidence                        |
| Context               | `SessionContextService` (`lifecycle/`)             | Operational precondition; no durable-state reconciliation |
| Workflow finalization | `SessionWorkflowFinalizer` (`lifecycle/`)          | Idempotent workflow completion                            |

`SessionScope` (`lifecycle/session-scope.ts`) owns the lifetime of per-session
in-memory state. Collaborators register disposers in the composition root, and
the coordinators run the scope's stages instead of listing collaborators:

| Stage           | Run by                                   | Disposers                                                                                                                                                                        |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginTeardown` | Stop and runtime exit, first             | Prompt-turn completion, queued ACP prompts                                                                                                                                       |
| `quiesce`       | Stop, before the runtime stops           | Streaming and replay state, pending permissions                                                                                                                                  |
| `settle`        | Stop and exit, after orphan finalization | ACP event state; permissions on exit                                                                                                                                             |
| `completeStop`  | Every stop, before the reservation ends  | Dispatch claim, steering, retries, mail claims                                                                                                                                   |
| `forget`        | `session_permanently_deleted`            | Configuration, observed-empty, queued PR delivery tokens, cached provider history, session store and initial message, transient archive marker, dispatch state and manual resume |

Stages run disposers in registration order and log, rather than propagate, a
disposer failure. Every stop caller (WebSocket, tRPC, admin, orchestration)
therefore resets dispatch state while the stop reservation still blocks new
dispatch. Every durable deletion reaches `forget`: session deletion through the
session data service or repository, and workspace deletion, which forgets each
cascaded session after the rows are gone. New per-session state should register
a disposer instead of adding a call to a coordinator.

When changing lifecycle behavior, keep these boundaries intact: coordinators and
services own their named responsibility and reconciliation evidence where
applicable; context supplies operational inputs. The lifecycle facade delegates
public operations and the session composition root wires the owners.

### Fencing primitives

Per-session work captures a token and re-checks it after each await. Pick the
narrowest fence that matches what the work must yield to. Paths are relative to
`src/backend/services/session/service/` unless they start with `src/`.

| Fence                                                         | Owner                                                              | Fences                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Lifecycle generation (`getGeneration`, `isGenerationCurrent`) | `SessionLifecycleGate` (`lifecycle/session-lifecycle-gate.ts`)     | Prompts, initial sends and event-owned work vs. stop, shutdown or an unestablished startup lease ending |
| Stop-only fence (`hasStopSince`)                              | `SessionLifecycleGate`                                             | Queue dispatch, steering and mail retries vs. explicit stop or shutdown only                            |
| Stop and shutdown reservations (`isSessionStopping`)          | `SessionLifecycleGate`                                             | Concurrent stops; startup and dispatch while a stop or runtime stop is in flight                        |
| Startup lease (`establishStartup`, `assertStartupAllowed`)    | `SessionLifecycleGate`                                             | Startup continuations after a stop                                                                      |
| Supervisor stop generation                                    | `AcpRuntimeSupervisor` (`acp/acp-runtime-supervisor.ts`)           | In-flight client creation vs. any runtime stop, including ungated ones                                  |
| Runtime incarnation and current handle                        | `AcpRuntimeSupervisor`                                             | Events, exits and prompt timeouts from a replaced process                                               |
| Observed-stop ownership (`canStopTarget`)                     | `AcpObservedStop` (`acp/acp-observed-stop.ts`)                     | Physical stop or cleanup of a replaced handle or provider source                                        |
| Prompt readiness and configured handle                        | `AcpPromptReadiness`, `acp/acp-configured-handle.ts`               | Prompts and config writes before configuration completes or after replacement                           |
| `SessionCallerGuard` (`check`, `assertCurrent`)               | Caller (`bridges/`; built by orchestration retry authority)        | Dispatch, config and prompts vs. loss of the caller's authority                                         |
| Event authority, `EventSessionFenceError`                     | `EventSessionAuthority` (`event-agent/event-session-authority.ts`) | Event-initial delivery and late durable writes vs. cancel, close or ownership change                    |
| `WorkspaceInitFenceError`                                     | `src/backend/lib/workspace-init-fence-error.ts`                    | Dispatch vs. workspace initialization policy (message stays queued)                                     |
| Event-owned work windows                                      | `EventOwnedWork` (`lifecycle/event-owned-work.ts`)                 | Work proofs vs. a later prompt, pending request, or stop and restart                                    |
| Dispatch claim token                                          | `SessionDispatchClaim` (`dispatch/session-dispatch-claim.ts`)      | Concurrent dispatch per session; stale releases                                                         |
| Notification dispatch claim and mail wake claim               | `SessionNotificationDeliveryService`                               | Duplicate or quarantined notification sends; stale wake settles                                         |
| PR delivery tokens (`validate`)                               | `SessionBackgroundDeliveryService`                                 | Queued PR updates from an old binding revision                                                          |
| Resume fence                                                  | `sessionResumeFences` (`store/session-resume-fence.ts`)            | User resume and input submission vs. user stop or runtime failure                                       |
| Config commit token and mutation queue                        | `SessionConfigCommitAuthority`, `SessionConfigMutationQueue`       | Superseded config commits; config edits across runtime replacement                                      |
| Store guard (`captureStoreGuard`)                             | `SessionDomainService`, `store/session-store-registry.ts`          | Dispatch and steering writes into an evicted or replaced store                                          |
| Provider history fence                                        | `SessionDomainService`, `lifecycle/session-startup-history.ts`     | History replay after store replacement, suspension or provider change                                   |
| Application update admission                                  | `src/backend/services/application-update-admission.service.ts`     | New dispatch and starts once an application update closes admission                                     |
| Workspace activity generation                                 | Workspace activity service (`markSessionRunning`)                  | A stale idle mark clearing a newer run                                                                  |

Dispatch uses the stop-only fence because a startup lease that ends without
establishing a runtime (a failed start, or `ensureSubagentBrowseSession`
returning `false` for a session without native sub-agent browsing) deletes the
lifecycle generation. A dispatch that captured it would otherwise return with
its message still queued and no retry. The supervisor keeps its own stop
generation: it also advances for runtime stops that never reserve through the
gate (failed-startup cleanup, observed and targeted stops), and ACP internals
cannot import the lifecycle gate.

## Task lists

The current task list appears inline beneath the conversation in workspace chat
and quick chat for both Claude and Codex. The UI uses the latest ACP plan
snapshot, including empty snapshots that clear the checklist. Older Claude
TodoWrite calls provide a fallback when no ACP plan has arrived. Completed tasks
remain visible and muted. Task lists stay hidden during session history loading;
session switches reset their ACP state. The former Tasks sidebar tab is removed,
and saved selections of that tab migrate to Changes. The session store retains
the latest validated ACP task snapshot for reconnect replay, including empty
lists. Plan snapshots emitted during provider history attachment pass replay
suppression so restored conversations can recover tasks. Authoritative session
snapshots include the current task list, so hydration clears stale client state
when no list exists; queue deltas leave the client's task list untouched.
Replacing a provider's archived history also clears its task snapshot.

## Provider sub-agents

Provider-initiated sub-agents are session-scoped, read-only, and provider-owned.
Factory Factory projects their native ACP metadata and transcripts into the
Subagents panel through its session-scoped tracker. Clicking a single running
sub-agent in the main chat opens its transcript tab directly, without expanding
a list. With multiple running sub-agents, the count expands an inline list;
selecting one opens its transcript tab directly. Completed sub-agents remain in
Subagents. The inline list deduplicates overlapping provider pages and retains
pagination and Retry controls when later pages are unavailable. The Subagents
panel's stored key remains `agents`; child-workspace access remains available
for parent workspaces. The count shows the assigned icons of up to three active
sub-agents in creation order; larger groups keep the full count without adding
more icons. Until all summary pages load without errors, the count remains
visible without placeholder agent icons. The Subagents list, lifecycle rows, and
sub-agent tabs share twelve nature icons claimed in creation order (with agent
ID breaking ties). Each sub-agent claims the lowest available icon; completion,
failure, cancellation, or interruption releases it for later agents. Lifecycle
timestamps reconstruct claims after reloads so every surface uses the same
assignments. Provider revisions to lifecycle timestamps or resumed threads can
change reconstructed assignments. Unknown lifecycle times conservatively retain
claims. More than twelve overlapping agents use distinct numbered badges; those
slots can also be reused after completion. Tabs preserve the assigned icon color
and pulse while starting or running. Unknown creation times sort last. Its
header counts active (starting, running, or waiting) sub-agents; terminal agents
remain under the separate collapsible Completed count. The panel automatically
loads all summary pages before showing the active count, so children on later
provider pages are included. A page failure keeps loaded rows visible and offers
Retry without displaying a partial count. Repeated provider cursors stop
automatic pagination and offer the same recovery instead of repeatedly fetching
the same page. Sub-agent tabs also load all summary pages, even after finding
the selected child, so earlier-created agents on later pages receive the same
icon ordering. Restored transcript selection uses the same cursor guard. Live
sub-agent events invalidate list queries by parent session, without cursor or
page-size fields, so infinite-query caches refresh newly spawned and completed
children without a page reload.

The chat timeline projects provider creation and completion timestamps into
separate, muted sub-agent start and finish rows. Failure, cancellation, and
interruption retain their own labels. In workspace-detail chat, start and finish
rows open the corresponding sub-agent transcript tab, including stopped agents.
Both workspace-detail and Quick Chat reconstruct the rows from provider metadata
when history reloads; unknown timestamps are not invented. Native ACP replay
without provider timestamps retains sub-agent summaries and transcripts for
browsing but leaves lifecycle times unknown, so reopening a workspace does not
append historical starts and finishes as new activity. Live native events still
use their observation time. If a request fails or the provider repeats a
pagination cursor, chat keeps known rows visible and offers Retry. Adjacent tool
activity stays collapsed by default as muted summary rows; expanding a summary
shows chronological calls with input and output available on demand. Failure
counts and warning icons appear only while the group is expanded; collapsed
summaries retain their activity icon (or running indicator).

Sub-agent transcript projection applies the same refinements without duplicating
tool cards and joins consecutive assistant text chunks before rendering
Markdown. Tool, reasoning, non-text content, and provider message-ID changes end
the text sequence, preserving separate replies and tool ordering.

The transcript follows the main chat's visibility rules: reasoning-only entries
are hidden, and tool sequences expand to show earlier activity. A child that
writes only final replies can therefore look like a short result summary even
when its complete tool history is available. The scroll-to-bottom control
appears only in reading mode when content remains below the viewport. The
content-below measurement is independent of reading intent, so fitting content
hides the control without resuming automatic following.

They are distinct from workspace-scoped child workspaces, and are recovered from
the provider when a parent session is reloaded rather than persisted by Factory
Factory. Stopped Codex sessions can restore a browse-only runtime to read native
history without sending a prompt. Other stopped providers may not expose that
history. When browsing is unavailable, the Subagents panel explains the
limitation instead of rendering a blank tab; this is distinct from a supported
session with no subagents.

## Child workspaces

A parent workspace can spawn child workspaces (in any project) via MCP tools
exposed to the agent (`spawn_child_workspace`, `send_message_to_child`,
`archive_child_workspace`, `list_projects`). Children report back via
`send_message_to_parent`.

Child-workspace MCP requests connect to localhost when `BACKEND_HOST` is unset
(the backend then binds `127.0.0.1`, plus `::1` where IPv6 is available) or is
an IPv4 or IPv6 wildcard, including equivalent compressed IPv6 spellings.
Explicit bind addresses remain the connection destination.

Messages are persisted as workspace inbox mail. Their bodies are never injected
automatically into an agent conversation. Agents receive a coalesced, body-free
“you have workspace mail” signal, inspect summaries with `list_mail`, retrieve
selected content with `read_mail`, and explicitly acknowledge IDs with
`ack_mail`. The workspace right panel exposes the same inbox to users. Chat
renders standalone mail signals as compact, collapsed envelope rows, hiding
agent instructions and receipt markers. Expanding a row loads the current inbox
and lets users open message bodies; the revision labels the notification rather
than a historical inbox snapshot. Reading and acknowledgement keep the same
explicit inbox behavior. Live and historical parent/child inbox notifications
also collapse to envelope rows with expandable message text. Combined user
prompts retain their full text so user instructions remain visible.

`PROGRESS` mail is quiet and can supersede older progress for the same sender
and task key; explicit task revisions prevent late progress from replacing a
newer revision. `MESSAGE`, `BLOCKER`, `QUESTION`, `COMPLETION` and `INSTRUCTION`
mail are actionable. Acknowledgement is separate from reading, provider wake
delivery, and completing the underlying task. Existing delivered notifications
migrate as acknowledged; pending notifications remain available as mail.

Lists default to 20 summaries (maximum 50), each with a preview of at most 160
UTF-16 units. Selected reads default to an 8,192-unit total body budget (maximum
16,384) across at most 20 IDs. Previews and chunks preserve surrogate pairs.
Long messages return continuation offsets; a one-unit budget that cannot fit the
next character reports an explicit error. The UI enables acknowledgement after
the complete selected body has been read. Superseded progress is hidden by
default and available through the explicit history filter. Read and
acknowledgement operations are scoped to the recipient workspace. Inbox previews
and bodies require trusted-local access, as do acknowledgement and explicit wake
retry. The MCP tools bind the recipient to their launch context.

The Inbox tab, board cards and sidebar rows show unread counts from one shared
project query rather than loading each workspace's messages. Counts match the
inbox's unread filter: only mail with no read, acknowledgement or supersession
timestamp is included, including current progress. The trusted-local endpoint
returns counts only, covering all inbox pages. It performs no read or
acknowledgement writes. Counts refresh every 15 seconds and after explicit UI
reads or acknowledgements; merely opening Inbox or viewing a board does not mark
mail read. Display counts cap at 99+, while accessible names retain the full
total.

A durable revision and fenced wake claim keep one outstanding notification per
workspace. New arrivals do not queue repeated prompts while a signal remains
outstanding. Acknowledging selected mail at an observed revision releases its
wake latch without acknowledging newer arrivals. Failed/full-queue wake claims
remain retryable. Supported native steering delivers the small signal during a
busy turn; unavailable steering retains the queued fallback for turn completion.
Both queued prompts and native steering persist an uncertainty fence before
provider submission. A failure after possible provider acceptance leaves a
durable ambiguous wake instead of replaying it automatically, including after
restart. The inbox exposes an explicit **Retry mail notification** action with
notice that it may notify the agent again. Unresolved delivery uncertainty
requires that explicit action. A valid late provider reply proving no injection
can instead disarm its exact claim and resume normal recovery under the current
session and workspace guards. Reading mail and acknowledging selected IDs remain
independent. Explicit startup assignments always precede recovered mail signals.

Max workspace depth is 1 — children cannot have child workspaces.
Provider-native subagents are a separate facility.

An event run whose workspace creates children settles only once every child is
at rest, or 24 hours after its own initial turn ended; see
[event initial delivery](#event-initial-delivery-infrastructure). Children are
never stopped by settlement and outlive their run as ordinary workspaces.

Child creation validates the target project's active status before delegating to
its injected workspace-launch owner. The workspace capsule still validates the
parent and depth and persists the parent, prompt, and report-back metadata.
Unlike interactive launch, the child policy resolves its provider after
persistence and attempts a `followup` / `Chat 1` session only when provider
resolution succeeds. It performs no capacity or CLI-health preflight. Provider
or session failure is best-effort; initialization still starts once in the
background. Parent notifications and child context handoff remain with their
existing owners.

UI: `ChildWorkspacesPanel` in the right panel, a child badge on kanban cards,
and an archive warning when a parent has active children.

- Orchestration:
  `src/backend/orchestration/workspace-lifecycle/workspace-children.orchestrator.ts`
- MCP entrypoint: `src/backend/mcp/workspace-mcp-server.ts`
- Session MCP spawn configuration:
  `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`

## Quick actions

Workspace quick actions are markdown-driven from `prompts/quick-actions/`
(frontmatter metadata + prompt body); that directory is their only source. The
composer's ⚡ **Quick actions** menu (`Cmd/Ctrl+Shift+A`) lists the agent
actions and offers **Run in this chat**, which sends the prompt into the current
chat, or **Run in new chat**, which creates a chat named after the action and
auto-sends the prompt once it is ready. "Run in new chat" is disabled, with the
reason shown, while a new chat can't start (workspace setup, the active chat
limit, the chat list still loading, or a chat being created or closed).
Composers without a workspace chat collection offer only "Run in this chat". The
workspace header's **Create PR** runs the `create-pr` action in a new chat.

The active chat limit (`MAX_SESSIONS_PER_WORKSPACE`) counts `RUNNING` and `IDLE`
sessions, except finished adversarial reviews: an `adversarial_review` session
that is `IDLE` and has started a provider session keeps its transcript but no
slot. A review created but not yet started still counts. Only a `RUNNING` review
blocks another review of the same PR, so a finished review can be run again. The
limit is checked when a session is created, not when it resumes, so continuing
the conversation in a finished review can briefly put the workspace over the
limit until that turn ends.

`prompts/` is copied into `dist/` on build and packaged alongside the unpacked
Electron backend, so a new prompt file ships without a code change.

## Desktop backend process

The desktop app runs the backend in an Electron utility process, not in Electron
main, so synchronous SQLite work, agent streams and terminals cannot freeze the
window or menus. `electron/main/server-manager.ts` forks
`src/backend/electron-utility-entry.ts` and passes the database, migrations,
frontend and log paths through the child environment. The child backs up the
database when migrations are pending, runs them, starts the server, and posts
`ready` with its URL or `error` over `process.parentPort`; startup that takes
longer than two minutes is killed.

Electron main opens the window as soon as the app is ready, showing a
self-contained loading page (`electron/main/loading-page.ts`, a `data:` URL with
no scripts or remote resources) while the backend starts, then loads the app
URL. A failed start destroys the loading window before the startup error dialog
and quit; closing it during startup stops the backend like closing any last
window, and the app URL is never loaded into a closed window.

The app window never opens child windows. `target="_blank"` links and
`window.open` calls open in the system browser or mail client, even for app
URLs, because a child window would inherit the preload bridge. Top-level
navigation and redirects that leave the loaded app's origin are cancelled and
opened externally. Only `http`, `https` and `mailto` URLs reach
`shell.openExternal`; other schemes are blocked
(`electron/main/external-links.ts`).

The native app menu exposes Settings, New workspace, Search and Toggle sidebar
through the renderer shortcut registry, preserving the same actions as keyboard
and command search. Commands wait for the trusted renderer subscription, so
opening a window or starting the backend does not lose the first menu action.
Standard editing and window controls remain available; Reload and DevTools are
development-only menu items.

The desktop shell (`electron/main/desktop-shell.ts`) saves normal window bounds
and maximization in `window-state.json` under Electron's userData directory on
close. It validates restored JSON and clamps bounds to the current display work
area, so removed monitors do not strand the window. Missing or corrupt optional
preferences do not block startup. The minimum window size is 640 × 480 (bounded
by the display work area). The loading window uses system appearance until the
renderer syncs the selected application's background, including theme presets
and custom overrides; trusted IPC accepts only an opaque hex color.

On macOS a utility process runs from the Electron Helper binary, so Electron
main also passes its own executable as `FF_NODE_EXEC_PATH`. Bundled adapters,
provider CLIs and the child-workspace MCP server launch with
`configService.getNodeExecPath()` and `ELECTRON_RUN_AS_NODE=1`; outside Electron
it is `process.execPath`.

Electron main stops the backend before quitting (`before-quit`) and when the
last window closes. Stopping sends `shutdown`, waits 25 seconds for a graceful
exit, then sends `SIGKILL`. A stop during startup cancels the start the same way
instead of waiting for the backend to become ready; the start then rejects even
if `ready` crosses the shutdown request, and the cancellation is not reported as
a startup error. Once quitting begins, activating the app does not start a new
backend. If a started backend exits on its own, the app offers to restart it,
reloading the window at the new URL, or to quit.

Electron fatal-error handlers await backend shutdown before quitting. Concurrent
fatal errors share one shutdown attempt. Cleanup failures and a 30-second
shutdown deadline are logged before the application exits, so a stalled startup
cannot hold the fatal-error path open indefinitely.

### Targeted interruption

Expanded background-process rows in chat and controllable sub-agent rows in the
Subagents panel expose an icon-only Stop action. Each action has its own
disabled spinner until live provider updates remove the work or withdraw its
capability; request acknowledgment does not invent completion. Failures use a
toast and allow retry. Pending attempts and their original deadlines survive
list/panel remounts, and confirmation waiting is bounded to 15 seconds.
Disconnecting hides controls, and stopping a row remains separate from selecting
its transcript.

The session-scoped `stopTarget` mutation validates an opaque live control ID
against the current active runtime's native tracker before dispatch. UI
references also carry the tracker's runtime identity, matched to the live work
snapshot. Current-connection hydration and a successful child-list refresh gate
controls after reconnect/runtime replacement; cached rows stay browseable while
controls wait for current capability data. Controls are renewed for child/task
generations and withdrawn during history replay, completion and capability
withdrawal. Browsing extensions and browse-only runtimes cannot grant control. A
stop never starts or restores a runtime. Background tasks require explicit
`canStop` and dispatch `_session/async_task/stop` with the root provider session
and retained task ID; child ownership separately fences tasks from superseded
child generations. Native child interruption requires an explicit
`capabilities.cancel` and sends `session/cancel` to that child's current ACP
session ID, preserving the parent and unrelated siblings. No parent-cancellation
fallback is used. Omitted native child patch fields keep their prior values; an
explicit `capabilities` object replaces the set, and `{}` or `null` withdraws
control.

The currently installed Claude and Codex adapters select the JetBrains Air (AIR)
private ACP extension contract, negotiated through
`clientCapabilities._meta.jetbrains.air` (including `asyncTasks`), for native
sub-agents and background tasks. They advertise no child cancellation capability
in that form. Their child rows therefore remain browseable without Stop. The
tracker accepts explicit cancellation metadata for known current native
children, including `subagent_update` capability changes, without changing
protocol negotiation or claiming support for a separate standard-protocol
lifecycle. Background-task stopping remains available where AIR advertises
`canStop`.

## Event initial delivery infrastructure

Event-owned sessions have a retained creation origin and a durable initial
prompt fence. Orchestration must inject the agent-definition owner's delivery
port before event startup or recovery. Missing or unavailable authority blocks
those sessions, including before observers are restored. Ordinary conversations
keep their existing policy; a durably finished initial delivery permits later
human turns after restart.

The `dispatchAgentInitialPrompt` API targets the reserved session and sends one
initial turn using its frozen execution and account binding. Its caller supplies
a synchronous current-claim guard. Human input stays in the ordinary queue
during setup and delivery. Queue reset, retry, manual resume, steering, direct
startup and configuration edits cannot remove the durable fence. The event
launcher freezes execution, creates and links the reserved workspace/session,
then uses strict owned initialization before this API. Saved agents are enabled
through the trusted-local `automation.enable` procedure; operators recover runs
from the automation's Runs view (see
[exact-context operator recovery](#exact-context-operator-recovery-transport)).

AgentRun.launchPreparation is a versioned physical-operation marker. A null or
SAFE marker with PENDING delivery can resume with the same identities. SETUP or
STARTUP is persisted before physical work; only a successful setup or confirmed
cleanup makes it safe again. Hard restart in those operations with PENDING
delivery produces held preparation/cleanup uncertainty: PENDING still proves
that the initial task was unsent. Once delivery is SENDING or ACCEPTED, recovery
retains delivery uncertainty and never automatically resends, even if STARTUP
remains marked. FINISHED initial outcomes remain immutable for later run
settlement. Marker-before-effect and cleanup-before-marker crash windows can
conservatively require operator resolution. Existing script PID/output and
capacity are retained while cleanup is uncertain; persisted PIDs are never
signalled. Git cleanup requires positive filesystem and canonical registration
absence even when the legacy removal promise resolves.

The targeted `interruptEventInitial` capability records the requested lifecycle
cause without ordinary user-stop finalization or clearing queued human input.
Monitoring supplies the exact expected attempt and runtime source; replacement
or unavailable source blocks the action, including after awaited owner reads.
Targeted ownership-read failure or timeout fails closed; ordinary explicit stop
and global shutdown keep their separate physical-cleanup fallback. Cleanup of a
finished initial failure waits for ordinary follow-ups and known agent work to
finish. Initial dispatch cancellation shares the existing evidence deadlines and
fences late observations; it does not close global authority. Failure and abort
cleanup carry the launch ownership guard through handoff, stop ownership/fence
reads, evidence publication and final disposition. Cleanup ownership is separate
from the aborted input signal, so a current owner still performs its shutdown
stop. Revoked cleanup cannot invalidate a replacement; already-started physical
cleanup remains joined before its launch releases physical-stage tracking.
Already-started observation writes remain tracked for final session teardown.
Setup cancellation joins actual Git operations and script cleanup directly, so
uncancellable Git may outlive the setup deadline while retaining ownership.
Durable reads and output/PID persistence use the existing bounded evidence
drain; expiration closes the launch guard permanently. A late read cannot start
physical work or a new write, and any already-started physical operation still
drains directly. A settled UNKNOWN setup cleanup has no reusable process-control
handle in the launcher; missing local state is never used as termination proof.

The send boundary persists SENDING after session serialization and provider
configuration readiness. It then rechecks the captured runtime, lifecycle and
claim before calling the provider. A failed pre-send write prevents invocation;
failed later evidence writes retain uncertainty. Current ACP v1 provides no
caller message idempotency key or conclusively correlated early acknowledgment,
so generic live activity and replay do not mark ACCEPTED. A response to the
captured prompt RPC records a terminal outcome directly. Local transcript rows
are display data, never acceptance evidence. Unknown provider history must not
be treated as proof of non-delivery.

AgentInitialDelivery stores versioned, validated runtime identity, sanitized
terminal outcome and stop evidence. Every write compares the current run worker
and delivery attempt. The original run initialMessageId remains unchanged when
an authorized retry rotates the current delivery identity. Terminal outcome
alone does not settle the run or release capacity; tracked agent work is a
separate reconciliation concern. Later human results cannot overwrite it.

The dormant runtime exposes transport-neutral inspection and explicit RESOLVE,
ABANDON and RETRY actions. Every action checks project, run, worker generation,
attempt generation and current message/send identities. The consumer permanently
fences the matching initial operation, including admission awaiting a durable
read, before targeted cleanup. This does not abort into a second untargeted stop
or revoke a replacement. Active human follow-ups block recovery cleanup.

Resolution requires correlated strict local stop plus a current stopped-work
window. RESOLVE and RETRY also require every child workspace to be at rest (see
below); ABANDON does not. RESOLVE retains the RUNNING slot for a later decision;
ABANDON closes it with an explicit decision separate from the provider outcome.
RETRY retains capacity continuously and preserves the run, workspace, session,
frozen account/input, original initialMessageId, setupStartedAt and inherited
attemptCount, including an exhausted budget. It rotates only the current send
identities and attemptGeneration, reuses the READY worktree without rerunning
setup, and replaces the consumer's old operation. Deleted or unavailable
resources block retry. Inspection includes directory existence and
read/traversal access in `retryResourcesAvailable` and reports a retry-specific
`retryBlocked` resource reason, separate from common proof blocks. An
unavailable retry directory does not block RESOLVE or ABANDON. Retry checks
resources before targeted stop and again at final transaction validation; losing
the directory during the write rolls back with `RESOURCES_UNAVAILABLE`. Settled
UNKNOWN setup cleanup, like any other common proof block, supports only ABANDON
with an accepted unproven stop (below). A run held by child workspaces that are
not at rest offers only ABANDON; RESOLVE and RETRY return `CHILD_WORK_UNPROVEN`.

Saved resolution JSON does not restore lost live coverage. Both a later action
and the rotated attempt's startup require the old stopped-work window to remain
valid. A restart between rotation and startup can therefore leave the new
attempt unsent and blocked. Ordinary startup/send remains allowed after a
finished initial turn, but invalidates prior proof; a pending retry uses the
existing durable initial-delivery fence. Only an independently resolved previous
attempt permits a new tracking window after history replay. Recovery uses the
same final synchronous proof check and asynchronous engine-commit limitation as
settlement.

Normal settlement requires the current initial runtime's live tracking window,
established before its send, and zero in-flight prompts, interactive requests,
active goals, native children and non-shell agent tasks. Shell/dev-server-only
work does not retain capacity. FF child workspaces of the run's workspace are a
separate hold: the run settles only when every child is at rest. A child is at
rest when it is archived, archiving or deleted (known only from its retained
`WorkspaceChildOrigin`), when its setup failed, or when it has started at least
once (`Workspace.hasHadSessions`) and none of its sessions has a turn running
(runtime activity `WORKING` or phase `starting`/`running`/`stopping`) or queued
input. A session waiting on a person's approval counts as at rest. A child that
is still setting up, or READY without ever starting a provider session, holds
the run. Orchestration reads these signals through the workspace and session
barrels (`observeChildRest`) and passes them to settlement, which compares the
observed child IDs with the current child rows and retained origins under the
ledger write lock and holds on any difference. Settlement is final: a child that
wakes later is an ordinary workspace, does not reopen the run and holds no
capacity, so real concurrent work can exceed the run limits. Settlement never
stops children, including for failed or cancelled runs. A child hold expires 24
hours (`childHoldDeadlineMs`) after the run's own initial turn ended (its
recorded outcome, else its stop evidence); the launch-maintenance observation
then settles the run with its own status and reason `CHILD_HOLD_EXPIRED`. The
settled delivery evidence records a bounded child proof: counts per state and at
most 20 children that were still held. Unknown historical child-history coverage
(`childHistoryVersion`) no longer holds a run; the live check decides. Missing
tracking, replay, source replacement and restart without live coverage remain
unknown; history inspection never starts a provider. A terminal
failure/cancellation, unexpected exit, timeout or workspace removal also needs
correlated strict runtime-stop evidence. Event runs freeze the global turn limit
at launch and use the durable send timestamp for their deadline. Both providers
default to unlimited, including historical runs without a saved limit; run
history advertises no deadline in that case. Ordinary turns read the setting
when each prompt starts. SHUTDOWN uncertainty remains reserved for recovery and
does not fall through to timeout.

The owner transaction persists the work proof and terminal result together,
checking worker, send attempt and current source. Settlement linearizes at its
final synchronous live-token validation after all awaited reads and mutations.
Observed work/source/lifecycle changes before that check roll back the write.
The database engine's asynchronous commit remains a gap: this is a contract for
supported FF-tracked work, not universal containment of future native activity
or remote effects. Tracker updates continue normally throughout persistence.

Observed PR links are unioned into bounded run results while work remains held.
Links attached to child workspaces are included after the run workspace's own
links, under the same 20-link bound. Successful quiescent work becomes
PR_CREATED when links exist; failed or cancelled initial work preserves its
outcome and links. Workspace deletion captures valid still-persisted PR
associations, including detached links, in the same SQLite write transaction as
the cascade. Attachments committed first are included; a concurrent attachment
cannot commit against the deleted workspace. Capture failure rolls back
deletion. This result-only update also supports terminal runs without a live
lease and preserves their status, summary, completedAt, provider outcome and
explicit recovery decision. The validated union filters invalid links and
retains at most 20 links across retries and deletion; it is not an unbounded
history. The required capture port is wired by orchestration and deletion fails
closed when unavailable. Capturing results or deleting a workspace never proves
work resolution or releases held capacity. Ledger pruning, trusted-local
operator transport and its Runs view recovery controls are implemented.
Monitoring never auto-archives a workspace and never stops a child workspace.

Event runtimes use an owned POSIX process group. Strict stop confirms
LOCAL_RUNTIME_GROUP_STOPPED only after observing that group disappear. A
permission-uncertain probe after a successful owned signal may wait within the
existing stop deadline, but does not permit escalation or count as absence.
Initial probe errors, signal errors and lost ownership remain unconfirmed.
Stopped-work proof also requires the retained stop source to match the original
source; every new runtime registration invalidates that retained proof. Adapter
exit, a signal acknowledgment, cancellation acknowledgment, a missing handle or
an IDLE snapshot is insufficient. Unsupported executable overrides, Windows
without conclusive tree evidence, and uncertain cleanup report UNKNOWN. Live
ownership is required; persisted PIDs are never used to signal a group after
restart. Legacy runtime launch and stop behavior is unchanged.

Group disappearance proves local runtime termination for the supported inherited
provider launch chains. It does not prove that remote or detached owned work is
quiescent, nor undo earlier external effects. Retry requires local runtime stop
and resolution of tracked owned work. USER_STOP, shutdown, timeout and
unexpected exit remain distinct causes. Shutdown interruption preserves
reconciliation and no-resend semantics instead of inventing a user cancellation.
Observation writes are awaited before completion; shutdown bounds its drain and
still attempts physical cleanup when persistence fails or times out. Missing
durable stop evidence remains an error and cannot authorize retry, settlement or
automatic capacity release; only a person's
[unproven Abandon](#abandon-without-proof) ends such a run.

Event stop separates immediate owned-runtime termination from creation and
observation draining. Startup failure cleanup never waits for its own creation
registration. Stop and shutdown drains have deadlines: stalled creation remains
fenced, uncertainty is retained, and cleanup proceeds for remaining sessions.
Unexpected adapter exit attempts cleanup of its current owned group even when
durable exit observation fails. Definitive spawn failure before any process is
created preserves the spawn error; a missing PID alone is not that proof.

Observation draining tracks complete read/write operations and waits for all
settled results. A timed-out drain closes its observation epoch so late reads or
writes cannot initiate another owner write. Already-started database operations
may finish; shutdown does not claim they were rolled back. Durable failure does
not suppress best-effort physical cleanup. A soft cancellation while the
pre-send write is pending prevents the subsequent provider invocation and keeps
uncertain persisted delivery fenced.

Concurrent cleanup callers share compatible physical stop work for the current
owned runtime; each caller retains its own stop cause. A caller's timeout does
not release physical stop fencing while termination is still running. Queued
quiescence callers recheck the active barrier before taking ownership, and
creation-internal cleanup continues to use the nonjoining physical primitive.

### Setup retry and event initial authority

Generic workspace setup retry reuses `EventSessionAuthority`'s initial-operation
admission map and injected durable fence reader. Its captured retry guard checks
both exact durable attempt identity and synchronous local currentness across
startup and the final provider prompt boundary. Availability DTOs and retained
history are explanatory reads, not execution permits.

An ordinary session starting after a workspace reaches READY does not by itself
block manual event recovery. Existing READY resource checks and reserved-session
runtime creation/drain proofs protect the event attempt; setup retry does not
add a workspace-wide activity ban or new process-stop authority.

Startup carries the same captured caller checks through recovered-notification
queue dispatch, queue-triggered client creation, configuration and the common
initial-prompt branch. A guard wait cannot switch the operation to a replacement
runtime. Runtime identity and the paired workspace retry caller fence are
checked synchronously at the provider effect; ordinary ready prompts retain
their immediate dispatch. A rejected, unsent retry restores only its own
runtime's idle state.

Paired workspace retry startup cleanup stops only its captured candidate.
Managed runtime exits retain queued input; explicit session stop still clears it
before stopping the runtime, and unmanaged exits retain their existing queue
reset. Headless stores with queued work remain in memory until consumption,
explicit stop or shutdown; empty inactive stores can still be evicted. Recovered
durable notifications stay pending when a guarded dispatch is rejected.

A prepared PR delivery carries its captured rejection cleanup through the
dispatch caller's final authority check. Rejection drains that exact claim
before returning; cleanup does not look up a replacement delivery by
queued-message ID.

Startup callers that own only an asynchronous authority check carry that check
through recovered-notification dispatch. A synchronous caller fence is optional
on the session dispatch contract; workspace retry guards still require their
local fence. Async-only dedicated bootstrap retains its existing full-stop
cleanup: a rejected dispatch leaves durable notifications pending, but that
cleanup may clear in-memory input. Explicit session stop clears queued work both
on entry and after physical cleanup, while its stop reservation remains held, so
input arriving during the stop is cancelled. Captured PR failure settlement
compares the attempt as well as the existing binding and recipient identity; a
failed settlement cannot pause a replacement binding.

Queue cleanup and queue-length reads do not create or activate a session store.
This keeps post-stop cleanup from reviving a permanently deleted transient
ratchet session, including while a viewer remains open, and preserves
rejection-only store expiration. Existing stores still clear queued work and
publish pending request/queue updates normally.

Resuming exhausted PR delivery allowance can reset an active claim's attempt
count. Its old captured settlement then fails the attempt fence, but owner
cleanup releases the active mapping. A subsequent existing idle or regular-poll
wake performs receipt recovery: delivered receipts settle, absent receipts can
reclaim under the current binding, and unavailable receipts pause explicitly.
The nested completion wake may still see the active map; this is not an
immediate-delivery or polling-time guarantee.

### Exact-context operator recovery transport

The trusted-local `automation.recoveryTarget` query accepts project, agent and
run IDs. Its owner reads membership and the current run/delivery tuple together,
returning an exact claim/current-send context or a bounded unavailable reason.
It performs no provider discovery, stop, adoption or mutation. History and
workspace origins intentionally omit current send identity and cannot authorize
recovery.

`automation.inspectRun` accepts that full context plus agent ID;
`automation.resolveAmbiguousRun` adds RESOLVE, ABANDON or RETRY. Both verify the
project/agent/run membership before reaching the application's existing recovery
consumer. They preserve the submitted claim and attempt, including the original
initial message and the current message/send attempt. A later action revalidates
independently; stale inspection or target data is never refreshed to make an
action succeed. Inspection returns only safe status and bounded availability,
without prompts, provider source/work evidence or transcripts.

`retryBlocked: RESOURCES_UNAVAILABLE` is separate from common proof and
preparation blocks. Child work is its own `childHold` block: the held children
(at most 20, with `heldCount`), the durable `deadlineAt`, and `keepsOutcome`.
While it is present only ABANDON is offered; RESOLVE and RETRY return
`CHILD_WORK_UNPROVEN`. Inspection and actions compare their child observation
with the current child set and fail (CONFLICT or `CHILD_WORK_UNPROVEN`) when a
child appeared in between; RESOLVE and RETRY observe children again after the
recovery stop. ABANDON with children still held records reason
`ABANDONED_WITH_CHILD_WORK`. A failed initial turn stays `FAILED`, as for any
ABANDON; a completed one keeps `COMPLETED` or `PR_CREATED` when the run's own
work was idle before the recovery stop; a cancelled initial turn stays
`CANCELLED`. ABANDON never stops children, and once a run is terminal by any
path its children no longer block run-context expiry. Missing directory, frozen
account or session resources prevent RETRY; otherwise supported RESOLVE/ABANDON
still depend on authoritative stopped-source and current tracked-work proof.
PENDING delivery means UNSENT, while incomplete setup retains its preparation
hold. Manual retry keeps the logical run, reserved workspace/session/account,
original message, setup start, inherited automatic attempt budget and initial
outcome; it rotates only the current send identity and send generation.

<a id="abandon-without-proof"></a>

Every run can still reach a terminal state by a person's explicit decision. When
inspection reports a common `blocked` reason (`WORK_PROOF_UNAVAILABLE`,
`PREVIOUS_WORK_PROOF_UNAVAILABLE`, `SOURCE_UNAVAILABLE` or
`PREPARATION_CLEANUP_UNCERTAIN`; for example an ambiguous first message after a
transport disconnect, live tracking lost in a restart, or uncertain setup
cleanup) and the session is still event-owned, it also reports
`unprovenAbandonAvailable: true`. ABANDON with `acceptUnprovenStop: true` then
ends the run even though its stop cannot be proven; the opt-in is rejected for
RESOLVE and RETRY, and an ABANDON without it is unchanged (`BLOCKED`). With the
opt-in, the action still runs the normal proven path when proof is available,
and otherwise still attempts a targeted strict stop of the run's own recorded
runtime source when a live handle exists (never a replacement). The owner write
keeps the exact claim and send checks (a stale context is `CONFLICT`) and the
child-set comparison, then records the result of the run's own first turn when
one was recorded, by the rule settlement uses: `COMPLETED` (`PR_CREATED` when
the run's result has pull request links) or `FAILED`; `CANCELLED` only when no
outcome was recorded (first message unsent or ambiguous, setup unfinished) or
the turn itself was cancelled. It also records reason `ABANDONED_UNPROVEN`,
which says the stop was not proven, `launchPhase` FINISHED, no lease or next
attempt, and an incremented `workerGeneration`. The increment fences every later
owner write for the old attempt: a late send, outcome, ambiguity or stop
observation, lease renewal and settlement all conflict, so nothing is resent and
nothing reopens or settles the run. The result is
`{ status: 'ABANDONED', unproven: true }` (a proven Abandon omits `unproven`).
The evidence gains `unprovenAbandon` (attempt, reason, decision time) and the
child proof. The decision adds no `resolution`, `work` proof or stop of its own;
fields already present, such as an earlier retry's resolution, stay as they
were, and `stop` holds only what was actually observed, such as an UNKNOWN
attempted stop. The consumer releases its local owner without starting a
replacement observer. The delivery state stays as it was (for example
AMBIGUOUS), so the reserved session keeps its initial-delivery fence against
ordinary sends, as after any Abandon of an unfinished delivery. Children are not
stopped, the workspace is neither archived nor deleted, and an agent that was
still running keeps working in its workspace until someone stops it there. The
freed slot lets the automation claim its next queued run, so real concurrent
work can exceed the run limits, as with child workspaces. Because the decision
is final and fenced, run-context retention treats a run with reason
`ABANDONED_UNPROVEN` as settled when its evidence attempt and `unprovenAbandon`
marker identify the stored current send (run, session, message, send attempt and
attempt generation) and its preparation marker parses. Their `workerGeneration`
is fenced and is not the run's current one: the evidence attempt may carry any
earlier generation, and the marker must carry exactly the generation before the
decision's own increment. When those hold, the run's copied context can expire
under the configured policy; a missing or mismatched marker is
`INVALID_STORED_DATA` and is retained.

The boundary uses existing socket locality, configured CIDRs, browser Origin and
explicit proxy trust rules. Origin-less loopback and other same-user local
processes satisfy locality; this is not authenticated human-versus-agent
isolation. Parent and child workspace MCP advertise only their workspace tools
and the existing sources/propose/getProposal authoring allowlist. They expose no
recovery target, inspection, action or activation tools.

The only client is the automation's Runs view
([agents feature guide](../../src/client/features/agents/AGENTS.md)). It reads
the target and inspection only when a person opens **Inspect**, sends the
inspected context unchanged with the chosen action, and on `CONFLICT` keeps its
dialog open with **Reload** instead of reading a fresh context and resending.

A fresh application-construction integration test exercises real production
bridge registration and public workspace deletion without preinstalling capture.
Unseen attached and retained detached PR links survive the cascade as compact
run results; capture or cascade failures roll back the transaction. This
provider-free witness proves construction/deletion wiring, not provider work
resolution or capacity release.

## Held for other guides

Rules, hazards and reasons from the migrated paragraphs that belong to another
area. Each entry quotes only the sentences it needs from the paragraph named
after it, verbatim. The migration that creates the named area's guide checks the
entry, moves what holds there and deletes the entry here. Paragraph numbers are
the rows of the disposition table in pull request #3242.

> Framing bounds each message, rather than reducing total replay bytes or adding
> pagination; the existing renderer transcript window and full backend
> transcript retention still apply.

Old paragraph 16. For the WebSocket router guide
(`src/backend/routers/websocket/`, task 2.9).
