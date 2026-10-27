# Agent Runtime

Rejected or failed messages restore their text and attachments only when the
current session composer is empty. A newer draft or attachment selection is
preserved, and clearing it later does not replay the earlier recovery.

The new-workspace slash-command palette prefers project command descriptions
over same-named global commands, matching the workspace-first precedence used
when loading a Claude session. Commands found only in the global directory
remain available.

## ACP runtime

All agent sessions use Agent Client Protocol over stdio JSON-RPC through
`@agentclientprotocol/sdk` 2.0.2 through its v1 `/unstable` entrypoint. Typed
client app handlers preserve elicitation and native subagent features;
`acp-connection.ts` owns SDK registration and peer-context calls. Claude uses
`claude-agent-acp` 0.94 and Codex uses the released
`@agentclientprotocol/codex-acp` 2.2.2. Factory Factory does not implement a
Codex harness adapter. Codex's compatible runtime is packaged with its adapter;
`ff codex login` authenticates that same runtime.

Adapter entrypoints run with the host Node runtime, including Electron's bundled
Node, and are unpacked in desktop packages. Model discovery uses the same
bundled Codex runtime, without starting an inference turn. Claude model
discovery uses an ephemeral ACP session with tools disabled. Both catalog
services coalesce requests and cache successful results for 30 seconds.

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

Permission defaults initialize new sessions. Existing sessions restore their
saved native access and Codex planning choices before publishing a new snapshot
or dispatching work. Prompts and user configuration changes wait for that
restoration on the current runtime handle. Invalid, mismatched, or unavailable
saved modes stop startup; legacy sessions without a snapshot retain the
configured-default fallback. Reviewer workflows always reapply their read-only
restrictions.

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

Auto-iteration sessions use `autoIterationPermissions`, with YOLO as the
fallback if settings cannot be read. Auto-iteration uses the same native
access-mode mapping as manual sessions. Scheduled Codex tasks retain their YOLO
access preset and scheduled Claude tasks retain their configured access preset.
PR updates inherit their main conversation’s configuration and do not use a
workflow-specific permission preset.

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
