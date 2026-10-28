# Agent Runtime

Rejected or failed messages restore their text and attachments only when the
current session composer is empty. A newer draft or attachment selection is
preserved, and clearing it later does not replay the earlier recovery.

The new-workspace slash-command palette prefers project command descriptions
over same-named global commands, matching the workspace-first precedence used
when loading a Claude session. Commands found only in the global directory
remain available. Claude provider caches exclude `project:` and `workspace:`
commands, including nested names, regardless of disk-scan availability. Passive
loads also reject scoped entries left in an older global cache.

Workspace notification recovery ignores provisional user transcript entries
while their provider dispatch is unsettled, including across session stop/reset.
Only settled transcript evidence can acknowledge delivery; a failed send leaves
its durable notification pending for a later startup to recover.

Child workspace creation offers active projects only and rejects archived target
projects at the orchestration boundary, including requests from MCP clients or
stale browser selections. Child inserts also connect only to active projects
inside their nested-write transaction, so concurrent archival cannot bypass the
preflight check. Existing children of archived projects remain visible.

## ACP runtime

All agent sessions use Agent Client Protocol over stdio JSON-RPC through
`@agentclientprotocol/sdk` 2.0.2 through its v1 `/unstable` entrypoint. Typed
client app handlers preserve elicitation and native subagent features;
`acp-connection.ts` owns SDK registration and peer-context calls. Claude uses
`claude-agent-acp` 0.98 and Codex uses the released
`@agentclientprotocol/codex-acp` 2.3.0. Factory Factory does not implement a
Codex harness adapter. Codex's compatible runtime is packaged with its adapter;
`ff codex login` authenticates that same runtime.

Adapter entrypoints run with the host Node runtime, including Electron's bundled
Node, and are unpacked in desktop packages. Model discovery uses the same
bundled Codex runtime, without starting an inference turn. Claude model
discovery uses an ephemeral ACP session with tools disabled. Both catalog
services coalesce requests and cache successful results for 30 seconds.

Session startup validates that the workspace working directory exists and is a
directory before spawning an adapter. Missing worktrees report the affected path
and require restoring the worktree before retrying. Node otherwise reports a
misleading `spawn <node> ENOENT` when the working directory is missing, even if
the Node executable exists.

Failed exact-conversation resumes retain the provider's diagnostic details and
original error so missing Codex rollout history is actionable instead of
appearing only as `Internal error`.

Provider-native configuration controls own access permissions. Codex `mode`
selects access and `collaboration_mode` selects planning independently. Claude
`mode` owns its native access/planning modes. Saved STRICT/RELAXED/YOLO defaults
remain backward-compatible preset inputs, mapped to advertised native values;
the ACP client never automatically grants a permission because of a preset.
Read-only review sessions use the provider's read-only/plan mode and reject all
permission escalation. Access modes, including Claude planning, use
`session/set_mode`. Models and other settings, including Codex collaboration,
use `session/set_config_option`; legacy model/mode response fallbacks remain
supported. Boolean options remain in backend snapshots while current chat
controls render select options.

### Provider and model selection

Each default application graph constructs its own session creation resolver and
data facade. Their forwarding callbacks use the graph's current workspace,
resolver, and `userSettingsQueryService` capabilities for persisted provider and
model defaults. The separate `userSettingsService` alias still serves PR/bridge
policy; substituting settings for both policies requires binding both aliases.
The session capsule also exports factories for explicit construction and retains
process-default singleton exports for legacy callers. Persistence accessors,
acquisition queues, and other runtime settings reads retain their existing
scope; this creation boundary does not isolate an entire application runtime or
make separate settings reads atomic.

Model selection uses the explicit launch choice, then the user's saved default
for that provider. Existing conversations retain their stored model. New and
resumed runtimes apply that model through the advertised ACP model option before
publishing ready configuration or accepting prompts. Unsupported choices fail
explicitly; they never silently select the first model. Codex's saved `default`
means its native default, and supported Claude family aliases resolve to the
advertised identity. Browse-only restoration does not change configuration.
Startup model configuration shares the bounded startup deadline and cancellation
signals. Passive catalog reads enrich available options without persisting a
guessed selection or overwriting a newer runtime/edit. Catalog-only chat
projections do not select a reasoning effort. Before native configuration is
available, the chat bar withholds the effort control rather than briefly
displaying the catalog default or first supported level.

Client settings remain intact while capabilities are unknown. Initial confirmed
configuration supersedes bootstrap model values; explicit edits and restored
reasoning/planning settings survive hydration. Configuration from a previous
session visit cannot update the newly selected conversation. A message submitted
before configuration arrives relies on the server's stored selection instead of
sending a hardcoded client model. Pending model choices stay visible until
confirmed. Rejected or unsent changes restore the confirmed model; request
correlation prevents an older rejection from discarding a newer choice. Each
conversation restores its own draft and attachments, including switches before
draft autosave completes. Model/configuration writes serialize per session
through persistence and state publication, including failure corrections;
different sessions remain independent. Accepted native observations, successful
RPC results, and startup snapshots share a configuration authority fence through
metadata reads, CAS retries, and publication. Failed requests leave the last
accepted state valid; superseded background writes stop without publishing a
stale result. Public snapshot persistence exhaustion propagates an error and
configuration correction; native asynchronous observations own their background
rejection and logging. The
[startup finalizer](#permission-and-configuration-readiness) owns startup
durability, permission checks, readiness, and failure cleanup. Later genuine
server changes remain authoritative after pending edits settle. Model-only
changes preserve a supported explicit reasoning effort; an unsupported effort
normalizes to the new model's confirmed default. Each session load has a
10-second UI loading safety timer, including creation from an empty Quick Chat.
This UI timer does not release backend configuration readiness.

### Launch thinking and Plan

Manual workspace creation offers the provider/model picker and compact thinking
and planning menus styled like the chat configuration controls. Planning shows
Default or Plan; unsupported selected Plan can still be cleared. New
conversations in an existing workspace (the workspace tab bar, Quick Chat, and
quick actions) have no launch pickers: they reuse the provider and model of the
workspace's oldest session, or the workspace provider and saved model default
when it has none, and omit thinking and Plan so the saved thinking default
applies with Plan off. Users change these per conversation from the composer.
Thinking levels and planning availability come from a disposable ACP session
configured with the selected provider/model; the provider-wide model catalog is
not used as a thinking capability list. Discovery submits no prompt, rejects
permission/tool callbacks, and closes its processes. Its endpoint requires the
trusted-local boundary used for local execution. Successful native results are
cached for 30 seconds per provider/model, with bounded cache and concurrent
discovery counts. Failed discovery offers Retry; creation waits for confirmed
options while model selection remains editable.

Each launch draft snapshots its saved provider defaults and retains explicit
thinking/Plan choices across provider switches and settings refreshes. A model
change that makes an explicit level unavailable keeps that choice visible and
blocks creation until a supported level or Default is selected. Unsupported
inherited preferences use the native default instead. Existing chat navigation
and periodic-task creation do not depend on launch-option readiness.

Launch requests distinguish an omitted `reasoningEffort` (saved provider
default), explicit null (native default), and a supported value (that exact
level). The UI submits its displayed resolved choice. Validated
`providerMetadata.launchSettings` stores initial intent with `applied: false`;
only the startup owner's final confirmed snapshot marks it applied. Intermediate
configuration snapshots cannot consume it. Startup refreshes durable intent
after context and runtime handoff. A conditional repository acknowledgment
compares the model/thinking/Plan actually applied with current desired fields at
its CAS boundary. Changed intent is reread and reapplied. Observed snapshots
cannot rewrite desired launch fields; only explicit stopped edits own those
patches. Per-start thinking/Plan overrides retain precedence and may leave
conflicting stored choices unconsumed. Explicit model selection keeps its
confirmed model column persistence semantics. Identity-matched confirmed
snapshots own later resumes, including edits made after launch and changes to
global defaults. A saved level no longer supported after a model change uses the
new model's native default; unsupported explicit launch levels fail before
prompts. Stopped-session edits require a durable snapshot write and report
persistence errors. Applied launch intent with a missing or invalid snapshot
stops resume instead of replacing confirmed choices with global defaults.

Plan-on selects Claude's native plan access mode or Codex's plan collaboration
mode. Plan-off retains the configured permission preset rather than applying a
legacy permissive execution preset. Explicit native failures or unconfirmed
settings stop startup before readiness and first dispatch. Existing reviewer
restrictions and browse-only restoration remain authoritative.

Queued message settings have a separate null meaning: no effort override. This
preserves confirmed startup thinking through the first automatic workspace
prompt and messages composed before capabilities load. Explicit queued thinking
values still apply before their prompt.

### Permission and configuration readiness

Tool permission prompts keep request content above the approval actions so long
provider option labels cannot squeeze the request. Tool previews preserve
literal text, line breaks, and indentation in a bounded, keyboard-scrollable
monospace panel; long lines scroll horizontally. Consent messages retain prose
formatting.

Permission defaults initialize new sessions. Existing sessions restore their
saved native access and Codex planning choices before publishing a new snapshot
or dispatching work. Prompts and user configuration changes wait for that
restoration on the current runtime handle. Invalid, mismatched, or unavailable
saved modes stop startup; legacy sessions without a snapshot retain the
configured-default fallback. Reviewer workflows always reapply their read-only
restrictions. An explicitly requested Claude plan preset authorizes its
confirmed native plan access; Codex planning changes its separate collaboration
control and retains the required access mode. Optional preset failures warn and
continue only while the current access still satisfies the authorized target.

The config-owned startup finalizer persists the current accepted snapshot
outside the public readiness queue. Snapshot storage owns metadata merging,
guarded CAS writes, and retry; it does not decide startup readiness. If native
configuration supersedes the final startup write, startup recaptures and
persists the current handle before opening readiness. The final durable intent
read precedes the last async request/lifecycle check; authority and required
permissions are then checked synchronously with actual readiness completion. A
changed required access mode fails startup, including observations during
permission RPC or persistence continuations.

A mandatory current configuration failure permanently rejects the candidate's
readiness and attempts to stop only that runtime incarnation, including a shared
candidate. Runtime identity and lifecycle generation fences preserve
replacements and newer stops. Caller-specific cancellation retains shared
cleanup protections: a healthy shared candidate's completion owner continues
under independent runtime/lifecycle guards, opens readiness for surviving users,
then rejects the cancelled request before its prompt. Native snapshot failures
after readiness remain best effort; their asynchronous owner catches and logs
rejection.

Configuration readiness intentionally has no independent timeout. If provider
setup stalls, prompts and settings remain blocked until setup fails, the child
exits, or the session is stopped; elapsed time never releases work with unknown
permissions.

Persisted ACP configuration snapshots are validated before use. Legacy Codex
collaboration/access tuples are converted into native options before startup,
inactive-session display, or strict PR continuation. Durable legacy `sess_`
provider identities remain unchanged; transport calls use the underlying native
Codex thread ID. A failed legacy resume cannot start a replacement conversation.
History loading accepts both legacy event messages and current public response
items, deduplicates copies per turn, and excludes injected context and internal
reasoning. Terminal output deltas are negotiated explicitly, accumulated with
per-tool and total pending-tool limits, and included in completed tool results.
Buffers are isolated by session and cleared on teardown.

Permission requests retain the provider's option IDs and choices. Upstream Codex
plan review is normalized into the application's plan UI. Interactive sessions
wait for a user response; read-only reviewers automatically reject plan
implementation. Both adapters own their plan implementation continuation; the
client does not enqueue a second approval turn. Structured questions use ACP
form elicitation, with validated answers mapped into the existing question UI.
Numeric fields display validation errors before submission, and blank enum
choices retain their exact provider values behind visible labels. String
patterns use bounded RE2 compilation and linear-time matching in the browser and
backend; unsupported expressions fail closed. Run `pnpm test:acp:manual` for the
live handshake or `pnpm test:acp:manual:prompt` to explicitly enable a read-only
model round trip. URL elicitation exposes the destination and message and
requires explicit consent; it never opens a URL automatically. Cancellation
resolves pending permissions and elicitations as cancelled and dismisses their
prompts.

Native subagent/session updates are captured before SDK validation because the
subagent contract is still a draft. Children retain separate transcripts and
permissions remain routed through the owning parent. The client negotiates
upstream background-task metadata and combines subagent, goal and task activity
so provider work outside a prompt keeps the session running. Native session
loading reconstructs child histories; no Factory Factory extension is required
from either adapter. Each child's in-memory transcript retains at most 100 turns
and 2 MiB of serialized updates. Oldest whole turns are evicted; an oversized
active turn is discarded until the next user turn. Cursors use monotonic turn
offsets, and expired cursors fail explicitly instead of returning another turn.

### Activity and prompt dispatch

Workspace/session activity and ownership of a conversation's prompt slot are
separate signals. `isSessionWorking` includes in-flight prompts, background
shell commands (including persistent preview servers), native subagents and
active goals. It drives runtime activity and the yellow work indicator; a
completed prompt retains that activity until the remaining work ends.
`isSessionPromptInFlight` answers only whether the current active runtime has an
unresolved prompt RPC. Browse-only runtimes do not own an active prompt slot.

Ordinary chat messages may be composed and queued during any turn. Dispatch
waits for the preceding prompt to complete, including time spent executing tools
or awaiting that turn's approval, question or elicitation. A background shell,
independently running child or active goal does not block the next parent prompt
once that RPC completes. The provider remains authoritative: if it reports an
active turn that the client cannot observe, the existing bounded busy retry
preserves the queued message.

Startup and required configuration must complete before submission. Workspace
initialization/manual-resume policy, compaction, per-session dispatch
serialization and stop/generation fences still apply. The prompt slot is
rechecked after auto-start; another caller may have acquired it while startup
was awaited. A stopped runtime can auto-resume through the existing launch
policy; being stopped is not permission to bypass setup or a failed exact
resume.

Automatic PR updates additionally wait for pending interactive requests, an
in-flight prompt in another conversation in the same workspace, valid recipient
and binding checks, and an unpaused delivery policy. Background activity alone
does not block delivery in either the recipient or another conversation. Receipt
recovery waits for the actual prompt or the specific delivery attempt, not
unrelated background work. Other conversations' prompts do not prevent a human
from sending to their selected conversation.

Factory Factory supplies workspace MCP servers through session-scoped adapter
configuration. It never writes the user's native Codex configuration. Requested
workspace MCP configuration takes precedence over stale entries left by older
Factory Factory versions; native configuration for other servers is retained.

Session stop history is durable: `SessionLifecycleEvent` rows are append-only,
deduplicated by session/attempt key, merged chronologically with provider
history, and rendered as structured chat rows after reconnect or restart. Normal
user turns have a four-hour deadline; auto-iteration has its own timeout.
Startup/stop incarnation fences protect runtime replacement and shutdown.

Provider protocol schemas are maintained by upstream adapters. Keep focused ACP
client contract tests when upgrading either dependency, including saved-session
resume, plan approval, questions, native subagents, and reviewer permissions.

### Usage and compaction

The composer usage control shows the latest ACP `usage_update.used` against
`usage_update.size`. These are current conversation occupancy snapshots,
including post-compaction readings; cumulative token accounting is separate.
Unknown occupancy stays unavailable until the provider reports it. Both
providers support the same control.

Plan limits are account-level readings shared across workspaces, available only
to trusted local clients. The session capsule coalesces and caches provider
reads for 30 seconds. Codex uses the packaged app-server's `account/read` and
`account/rateLimits/read`; Claude uses its SDK's experimental structured usage
control with behavior scanning disabled. These disposable probes submit no model
turns and do not alter active conversations. Missing subscription data is
unavailable, and failed reads offer refresh rather than implying an unused
quota. Claude's experimental response is validated at the boundary and may need
updating with future SDK releases. Windows quota probes launch the packaged
native Codex executable directly; Unix probes own a detached process group for
reliable descendant cleanup.

Compact sends `/compact` through the normal session queue, preserving the
composer draft and excluding draft attachments. It is disabled while work is
running, compaction is active or the connection is unavailable. Native
`clientCapabilities.session.compaction` negotiation enables typed compaction
updates. Start updates show progress; only completed updates add the concise
context boundary. Duplicate terminal metadata patches do not create duplicate
boundaries. Failed and cancelled compactions end progress with their outcome and
never claim success. Retained model summaries are not rendered as new assistant
answers; conversation history remains visible.

Run the opt-in live check with:

```sh
RUN_REAL_PROVIDER_COMPACTION_TESTS=1 pnpm exec vitest run src/backend/services/session/service/acp/acp-compaction.manual.integration.test.ts
```

It creates disposable sessions for both providers, seeds a marker, compacts,
checks native usage/lifecycle updates and verifies follow-up recall without tool
calls. Native compaction can increase occupancy for short conversations, so the
UI reports the provider reading without promising a particular reduction.

### Failed provider resume

An active session whose provider cannot load its stored identity explicitly
reports `resume_fallback` (load failed or load unsupported). Browsing continues
to fail without creating a replacement. Startup keeps the replacement runtime
unavailable until the lifecycle owner reconciles it.

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
persistence are pending. Overflow cancels startup and terminates its candidate;
it never installs a runtime with a silently truncated transcript. Rollover
fencing rejects further reconciliation after overflow, and a later startup can
retry.

### Session prompts

ACP init/load uses the provider's built-in instructions; Factory Factory does
not supply a custom system prompt. Task prompts are sent as ordinary session
messages:

- Issue starts: `src/shared/issue-start-prompt.ts`, shared with the editable UI
  preview. It supplies untrusted issue data, the implementation/PR outcome,
  repository-defined verification, and screenshot/PR metadata.
- PR updates: `src/backend/prompts/pr-event.ts` renders bounded facts and a
  trusted enablement control for the existing main conversation. Delivery uses
  the source-aware session queue and strict provider resume; see
  [PR updates](pull-requests.md).
- Quick actions: `prompts/quick-actions/` (see below).
- Auto-iteration: `src/backend/services/auto-iteration/service/prompts.ts`.
  Implementation turns make one focused change; the loop owns verification and
  keep/revert decisions. Measurement and critique turns retain their JSON
  contracts, and the final turn creates a PR for accepted changes.
- Child workspace starts append `buildChildWorkspaceContext` through workspace
  initialization. Conversation-based branch renaming sends a separate prompt
  through the rename interceptor.

Legacy workflow templates and unused system-prompt construction have been
removed. Stored workflow IDs still select session behavior and permissions. Keep
prompts focused on outcomes and actual automation contracts, and defer
repository-specific tools and verification commands to repository guidance.

Claude ACP retains its bare Claude Code preset and existing prompt snapshot
behavior. Before introducing custom system-prompt metadata, revisit the SDK's
custom/append snapshot semantics. See
[the upgrade validation](../superpowers/plans/2026-09-09-remaining-dependencies.md).

Auto-iteration session start, prompt, transcript reads, stop, recycle, and their
compensation belong to `auto-iteration-session.orchestrator.ts`.
`configureDomainBridges` constructs that bridge from narrow session and
workspace capabilities. Recycling stops the predecessor, creates and starts its
replacement, writes the loop pointer, sends the handoff, then retires the
predecessor. Failed handoffs settle only matching session IDs and clean up the
replacement without masking the original error. Successful pointer writes remain
unconditional; the auto-iteration caller also writes the returned session ID.

Auto-iteration sessions use `autoIterationPermissions`, with YOLO as the
fallback if settings cannot be read. Auto-iteration uses the same native
access-mode mapping as manual sessions. Scheduled Codex tasks retain their YOLO
access preset and scheduled Claude tasks retain their configured access preset.
PR updates inherit their main conversation’s configuration and do not use a
workflow-specific permission preset.

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

## Session lifecycle ownership

`SessionLifecycleGate` owns domain startup/stop eligibility.
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
effect after gate cleanup.

Queue execution belongs to the single `SessionDispatchService` configured in
`session-services.ts`. Initialization, notification delivery, lifecycle queue
recovery, and prompt completion use its dispatch capability directly. The chat
registry's dispatch, reset, and manual-resume callbacks reach that same instance
through the transport-owned chat router. Lifecycle generation, delivery claim,
and transcript-commit ownership remain with their existing services.

Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility        | Owner                                | Reconciliation point                                      |
| --------------------- | ------------------------------------ | --------------------------------------------------------- |
| Startup               | `SessionStartupCoordinator`          | Persisted `RUNNING` state                                 |
| Termination           | `SessionTerminationCoordinator`      | Persisted idle/stopped state                              |
| Runtime exit          | `SessionRuntimeExitCoordinator`      | Terminal status and unexpected-exit lifecycle history     |
| Notifications         | `SessionNotificationDeliveryService` | Transcript plus delivered evidence                        |
| Context               | `SessionContextService`              | Operational precondition; no durable-state reconciliation |
| Workflow finalization | `SessionWorkflowFinalizer`           | Idempotent workflow completion                            |

When changing lifecycle behavior, keep these boundaries intact: coordinators and
services own their named responsibility and reconciliation evidence where
applicable; context supplies operational inputs. The lifecycle facade delegates
public operations and the session composition root wires the owners.

## Provider sub-agents

Provider-initiated sub-agents are session-scoped, read-only, and provider-owned.
Factory Factory projects their native ACP metadata and transcripts into the
Agents panel through its session-scoped tracker.

They are distinct from workspace-scoped child workspaces, and are recovered from
the provider when a parent session is reloaded rather than persisted by Factory
Factory.

## Child workspaces

A parent workspace can spawn child workspaces (in any project) via MCP tools
exposed to the agent (`spawn_child_workspace`, `send_message_to_child`,
`archive_child_workspace`, `list_projects`). Children report back via
`send_message_to_parent`.

Child-workspace MCP requests connect to localhost when the backend binds to an
IPv4 or IPv6 wildcard, including equivalent compressed IPv6 spellings. Explicit
bind addresses remain the connection destination.

Messages are persisted first as `WorkspaceNotification` rows, then delivered
live to active sessions when available; undelivered rows are delivered at the
next session start. Max depth is 1 — children cannot have children.

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

- Orchestration: `src/backend/orchestration/workspace-children.orchestrator.ts`
- MCP server:
  `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`

## Quick actions

Workspace quick actions are markdown-driven from `prompts/quick-actions/`
(frontmatter metadata + prompt body). Agent quick actions create follow-up
sessions and auto-send the prompt content once the session is ready.

`prompts/` is copied into `dist/` on build and packaged alongside the unpacked
Electron backend, so a new prompt file ships without a code change.

Electron fatal-error handlers await backend shutdown before quitting. Concurrent
fatal errors share one shutdown attempt. Cleanup failures and a 30-second
shutdown deadline are logged before the application exits, so a stalled startup
cannot hold the fatal-error path open indefinitely.
