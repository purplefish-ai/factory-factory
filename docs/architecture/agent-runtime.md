# Agent Runtime

## ACP runtime

All agent sessions use the Agent Client Protocol (ACP) via
`@agentclientprotocol/sdk`. CLAUDE sessions spawn `claude-agent-acp`; CODEX
sessions spawn Factory Factory's internal `codex-app-server-acp` adapter, both
over stdio JSON-RPC. The direct SDK dependency matches Claude ACP's SDK 1.4.
Model changes use `session/set_config_option`. Legacy model/mode response
fallbacks remain supported; model and mode controls require select options.
Boolean options are retained in backend configuration but omitted from the
current select-only chat controls. The internal Codex adapter accepts string
configuration values and stdio/HTTP/SSE MCP servers; it rejects ACP-tunneled MCP
servers, which it does not advertise support for.

Persisted ACP config snapshots are validated with a strict schema for ACP select
and boolean options before being used for inactive-session options or capabilities. Malformed
snapshots are treated as cache misses; provider history identity recovery stays
independent of configuration validity. Valid snapshots restore omitted model/mode
categories for both providers, while retaining Codex's provider-supplied labels.

Session init/load fails unless model/mode select options can be obtained from
provider `configOptions` or legacy model/mode response fields. Permission requests
present multi-option selection
(`allow_once`, `allow_always`, `deny_once`, `deny_always`) and are bridged
through ACP permission response handlers. Soft cancellation (including voice stop
and prompt timeout) resolves pending permission requests with a cancelled outcome,
dismisses their prompts, and keeps the bridge available for later turns.

Session stop history is durable: `SessionLifecycleEvent` rows are append-only,
deduplicated by session/attempt key, merged chronologically with provider
history, and rendered as structured chat rows after reconnect or restart.

The Codex adapter suppresses late turn notifications for the last 128 cancelled
turns per loaded session, before emitting chat updates or invalidating subagent
transcripts. Eviction emits a `cancelled_turn_history_evicted` diagnostic; an
evicted turn no longer has this protection against late notifications.

When reloading a stopped session, transcript recovery matches tool results to
call occurrences across the full transcript before synthesizing interruption
results. Provider history backfill can timestamp-sort a result before its call;
that existing result still completes exactly one occurrence of the tool ID.

Normal user turns have a fixed four-hour deadline; auto-iteration keeps its
separate configured deadline. Explicit stops, closes, workspace archives,
provider failures, prompt timeouts, and unexpected process exits record distinct
typed reasons.

Admin Claude model options come from an ephemeral, non-persisted Claude ACP
session with tools disabled; discovery failure falls back to static aliases.
Claude model names are normalized from provider descriptions at every ACP config
ingress so Admin and in-chat selectors show explicit family versions while
preserving raw provider values and configured defaults.

Admin Codex options and inactive-session chat capabilities share
`CodexModelCatalogService`. It coalesces concurrent app-server discovery,
caches successful catalogs for 30 seconds from completion, and gives each
consumer an isolated copy. Discovery failures are not cached; each consumer
keeps its existing fallback and the next request retries discovery.

The ACP layer is import-fenced by dependency-cruiser
(`acp-no-external-imports`, `codex-app-server-adapter-self-contained`,
`session-model-import-boundary`, `session-runtime-import-boundary`). The Codex
app-server schemas are generated — run `pnpm codex:schema:generate` and check
drift with `pnpm check:codex-schema`.

### Claude SDK dependency override

Claude ACP 0.75.1 pins Claude Agent SDK 0.3.257. `pnpm-workspace.yaml` scopes
an override to SDK 0.3.266 for upstream permission-handling fixes. Remove the
override when ACP adopts an equal or newer SDK. The upgrade was checked against
ACP's offline turn/cancellation, session options, resume, and file audit suites,
including coalesced results stamped with the last user UUID and the new UUID array.
These checks do not exercise live model streaming or prompt persistence.

Factory Factory's session init/load paths do not forward a custom system prompt;
ACP's bare Claude Code preset retains its existing prompt snapshot behavior.
Before changing that metadata, revisit the SDK's custom/append prompt snapshot
semantics. See [the upgrade validation](../superpowers/plans/2026-09-09-remaining-dependencies.md).

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

Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility | Owner | Reconciliation point |
| --- | --- | --- |
| Startup | `SessionStartupCoordinator` | Persisted `RUNNING` state |
| Termination | `SessionTerminationCoordinator` | Persisted idle/stopped state |
| Runtime exit | `SessionRuntimeExitCoordinator` | Terminal status and unexpected-exit lifecycle history |
| Notifications | `SessionNotificationDeliveryService` | Transcript plus delivered evidence |
| Context | `SessionContextService` | Operational precondition; no durable-state reconciliation |
| Workflow finalization | `SessionWorkflowFinalizer` | Idempotent workflow completion |

When changing lifecycle behavior, keep these boundaries intact: coordinators
and services own their named responsibility and reconciliation evidence where
applicable; context supplies operational inputs. The lifecycle facade delegates
public operations and the session composition root wires the owners.

## Provider sub-agents

Provider-initiated sub-agents are session-scoped, read-only, and provider-owned.
Factory Factory surfaces their live metadata and transcripts through
`factoryfactory.ai` ACP extensions and displays them in the Agents panel.

They are distinct from workspace-scoped child workspaces, and are recovered from
the provider when a parent session is reloaded rather than persisted by Factory
Factory.

## Child workspaces

A parent workspace can spawn child workspaces (in any project) via MCP tools
exposed to the agent (`spawn_child_workspace`, `send_message_to_child`,
`archive_child_workspace`, `list_projects`). Children report back via
`send_message_to_parent`.

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

`prompts/` is copied into `dist/` on build, so a new prompt file ships without a
code change.

Electron fatal-error handlers await backend shutdown before quitting. Concurrent
fatal errors share one shutdown attempt. Cleanup failures and a 30-second
shutdown deadline are logged before the application exits, so a stalled startup
cannot hold the fatal-error path open indefinitely.
