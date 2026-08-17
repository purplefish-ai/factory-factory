# Agent Runtime

## ACP runtime

All agent sessions use the Agent Client Protocol (ACP) via
`@agentclientprotocol/sdk`. CLAUDE sessions spawn `claude-agent-acp`; CODEX
sessions spawn Factory Factory's internal `codex-app-server-acp` adapter, both
over stdio JSON-RPC.

Session init/load is fail-fast and requires provider `configOptions` with
model/mode categories. Permission requests present multi-option selection
(`allow_once`, `allow_always`, `deny_once`, `deny_always`) and are bridged
through ACP permission response handlers.

Session stop history is durable: `SessionLifecycleEvent` rows are append-only,
deduplicated by session/attempt key, merged chronologically with provider
history, and rendered as structured chat rows after reconnect or restart.

Normal user turns have a fixed four-hour deadline; auto-iteration keeps its
separate configured deadline. Explicit stops, closes, workspace archives,
provider failures, prompt timeouts, and unexpected process exits record distinct
typed reasons.

Admin Claude model options come from an ephemeral, non-persisted Claude ACP
session with tools disabled; discovery failure falls back to static aliases.
Claude model names are normalized from provider descriptions at every ACP config
ingress so Admin and in-chat selectors show explicit family versions while
preserving raw provider values and configured defaults.

The ACP layer is import-fenced by dependency-cruiser
(`acp-no-external-imports`, `codex-app-server-adapter-self-contained`,
`session-model-import-boundary`, `session-runtime-import-boundary`). The Codex
app-server schemas are generated — run `pnpm codex:schema:generate` and check
drift with `pnpm check:codex-schema`.

## Session lifecycle ownership

`SessionLifecycleGate` owns domain startup/stop eligibility. `AcpRuntimeManager`
owns subprocess handles, pending creation, incarnation filtering, and
quiescence. Lifecycle work has one owner per responsibility; transport handlers
consume the composed services and never wire lifecycle dependencies.
Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility | Owner | Reconciliation point |
| --- | --- | --- |
| Startup | `SessionStartupCoordinator` | Persisted `RUNNING` state |
| Termination | `SessionTerminationCoordinator` | Persisted idle/stopped state |
| Runtime exit | `SessionRuntimeExitCoordinator` | Terminal status and provider history |
| Notifications | `SessionNotificationDeliveryService` | Transcript plus delivered evidence |
| Context | `SessionContextService` | Session context is resolved before lifecycle work |
| Workflow finalization | `SessionWorkflowFinalizer` | Idempotent workflow completion |

When changing lifecycle behavior, keep these boundaries intact: coordinators
or services reconcile their own responsibility, while the lifecycle facade
delegates public operations and the session composition root wires the owners.

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
