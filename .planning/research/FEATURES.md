# Feature Landscape: ACP-Only Cutover

**Domain:** Agent communication protocol migration -- replacing custom provider protocols
**Researched:** 2026-02-13
**Confidence:** HIGH (primary sources: ACP specification, TypeScript SDK docs, Zed adapter repos, existing codebase)

## Context

Factory Factory currently communicates with two AI providers through bespoke protocols:
- **Claude:** Custom NDJSON bidirectional streaming over stdio (`ClaudeProtocol` class, `control_request`/`control_response` pattern)
- **Codex:** Custom JSON-RPC app-server over stdio (`CodexAppServerManager`, `CodexSessionRegistry`, method-based approval flows)

The ACP (Agent Client Protocol) is a standardized JSON-RPC 2.0 protocol that both providers now support via Zed's production adapters (`@zed-industries/claude-code-acp` v0.16.1, `@zed-industries/codex-acp`). This cutover replaces both custom protocols with a single ACP client runtime.

**Key insight from research:** ACP is not just a wire format change. It fundamentally changes three interaction contracts:
1. **Permissions** shift from boolean allow/deny to multi-option selection (allow_once, allow_always, reject_once, reject_always)
2. **Configuration** shifts from imperative commands (`sendSetModel`, `sendSetMaxThinkingTokens`) to declarative config options with categories (mode, model, thought_level)
3. **Session identity** shifts from provider-specific session tracking to a unified `sessionId` returned by `session/new`

## Table Stakes

Features users expect. Missing = ACP cutover is incomplete or broken.

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| **ACP subprocess lifecycle per session** | Each FF session needs its own ACP adapter process (stdio). Replaces `ClaudeClient.create()` and `CodexAppServerManager.spawn()`. | MEDIUM | None -- foundational |
| **ClientSideConnection wiring** | The `@agentclientprotocol/sdk` `ClientSideConnection` class manages JSON-RPC over stdio. Must instantiate with a `toClient` callback returning the FF client handler. Replaces `ClaudeProtocol.start()`. | MEDIUM | ACP subprocess lifecycle |
| **initialize handshake** | Must call `connection.initialize()` with `protocolVersion`, `clientCapabilities` (fs, terminal), `clientInfo`. Agent responds with capabilities, config options, supported features. Replaces `protocol.sendInitialize()`. | LOW | ClientSideConnection wiring |
| **session/new** | Creates an ACP session with `cwd` (workspace working directory) and optional `mcpServers`. Returns `sessionId` which becomes the `providerSessionId`. Replaces implicit session creation in Claude CLI and `thread/new` in Codex. | LOW | initialize handshake |
| **session/prompt** | Sends user messages with content blocks (text, optional images). Returns `PromptResponse` with `stopReason`. Replaces `protocol.sendUserMessage()` and Codex `turn/create`. | MEDIUM | session/new |
| **session/cancel** | Sends cancellation notification to halt ongoing prompt turn. Agent must return `cancelled` stop reason. Replaces `protocol.sendInterrupt()` and Codex abort. | LOW | session/prompt |
| **session/update notification handling** | Must implement `Client.sessionUpdate()` callback to receive streaming updates: `agent_message_chunk`, `tool_call`, `tool_call_update`, `agent_thought_chunk`, `plan`, `config_options_update`, `current_mode_update`, `available_commands_update`, `user_message_chunk`. This is the main event translation surface. | HIGH | ClientSideConnection wiring |
| **ACP event translation to FF delta events** | Map ACP `SessionUpdate` variants to existing FF WebSocket delta events (`agent_message`, `stream_event`, `tool_progress`, `tool_use_summary`, `system_init`, etc.) or define new ACP-native delta events. The frontend must still render correctly. | HIGH | session/update notification handling |
| **Permission option selection (session/request_permission)** | Must implement `Client.requestPermission()` callback. ACP sends `toolCall` details + `options[]` array (each with `optionId`, `name`, `kind`). Kind values: `allow_once`, `allow_always`, `reject_once`, `reject_always`. Must return `{ outcome: 'selected', optionId }` or `{ outcome: 'cancelled' }`. Replaces boolean allow/deny `ControlResponseBody`. | HIGH | session/update notification handling |
| **Frontend permission UI update** | Current UI shows allow/deny buttons for tool permissions. Must change to render ACP permission options (potentially 4 choices: allow once, allow always, reject once, reject always). Each option has a `name` from the agent. | MEDIUM | Permission option selection |
| **configOptions-driven model/mode/reasoning controls** | After `session/new` and via `config_options_update` notifications, agent provides `configOptions[]` array. Each option has `id`, `name`, `category` (mode, model, thought_level, or custom), `type: "select"`, `currentValue`, `options[]`. Must render in UI and call `connection.setSessionConfigOption()` on user selection. Replaces `protocol.sendSetModel()`, `protocol.sendSetMaxThinkingTokens()`, and `protocol.sendSetPermissionMode()`. | HIGH | session/new, session/update notification handling |
| **Frontend config option UI** | Replace provider-specific model/reasoning dropdowns with generic config option selectors driven by ACP `configOptions` array. Group by category. Respect option ordering (higher priority first). | MEDIUM | configOptions-driven controls |
| **Tool call status rendering** | ACP tool calls have `status` lifecycle: `pending` -> `in_progress` -> `completed`/`failed`. Each has `toolCallId`, `title`, `kind` (read, edit, delete, execute, think, fetch, other), content, and file locations. Must render these in the chat UI. Replaces Claude `tool_use`/`tool_result` content blocks and Codex tool notifications. | MEDIUM | session/update notification handling |
| **Process management (stop/kill)** | Must cleanly terminate ACP subprocess on session stop. Handle process exit events. Update session runtime state. Replaces `ClaudeClient.stop()`/`ClaudeClient.kill()` and `CodexAppServerManager` shutdown. | MEDIUM | ACP subprocess lifecycle |
| **Provider launch config** | Must know which binary to spawn for each provider: `claude-code-acp` (npm) or `codex-acp` (npm, platform-specific binary). Store pinned versions. Pass required env vars (`ANTHROPIC_API_KEY` for Claude, `CODEX_API_KEY`/`OPENAI_API_KEY` for Codex). | LOW | None |
| **Legacy code removal** | Remove: `ClaudeProtocol` class, `ClaudeProtocolIO`, `ClaudePermissionCoordinator`, `ClaudeClient` (current), `CodexAppServerManager`, `CodexSessionRegistry`, `CodexEventTranslator`, `CodexDeltaMapper`, Codex schema snapshots, interactive method sets, all associated tests. | HIGH | All above features working |
| **Session file logging for ACP events** | Must continue logging ACP events to session file logger for debugging. Replaces current `sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', ...)` calls. | LOW | session/update notification handling |

## Differentiators

Features that set the ACP cutover apart from a naive protocol swap. Not strictly required for parity, but valuable.

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|--------------|
| **session/load (resume previous session)** | ACP supports loading a previous session by ID. Agent replays full history via `session/update` notifications before returning. Enables session resume without FF-side transcript replay. Must capability-gate (`agentCapabilities.loadSession`). | MEDIUM | session/new, capability negotiation |
| **unstable_listSessions** | List available sessions with metadata. Could power a "resume session" picker. Unstable API -- must be capability-gated and gracefully degrade. | LOW | session/load |
| **Unified runtime manager** | Instead of `ClaudeRuntimeManager` + `CodexAppServerManager`, a single `AcpRuntimeManager` that manages ACP subprocess lifecycle for both providers. Reduces code duplication. | MEDIUM | ACP subprocess lifecycle |
| **Config option update reactivity** | When the agent pushes `config_options_update` (e.g., model falls back, mode changes), the UI updates immediately without user action. Current UI does not have this -- model/mode are set-and-forget. | LOW | configOptions-driven controls |
| **Tool call file location tracking** | ACP tool calls can report affected file paths with line numbers via `locations` field. Could enable "follow along" file highlighting or click-to-open. | LOW | Tool call status rendering |
| **Agent thought rendering** | ACP streams `agent_thought_chunk` updates separately from message content. Could render thinking/reasoning in a collapsible section. | LOW | session/update notification handling |
| **Plan rendering** | ACP streams `plan` updates with task entries and status. Could render a structured plan view. | LOW | session/update notification handling |
| **Slash command forwarding** | ACP supports `available_commands_update` notifications to advertise slash commands. Can replace current initialize-time command extraction. | LOW | session/update notification handling |
| **Capability-gated features** | Agent advertises capabilities during `initialize` (`loadSession`, `promptCapabilities.image/audio`, `mcp.http/sse`). Use these to conditionally show UI features. | LOW | initialize handshake |
| **Health reporting for per-session processes** | Current admin/health surfaces report on Claude process registry and Codex manager status. Must update for ACP-per-session model where each session has its own PID. | MEDIUM | ACP subprocess lifecycle, process management |

## Anti-Features

Features to explicitly NOT build in this cutover.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Backward compatibility shim for legacy protocols** | Issue #996 explicitly states "pre-release breaking change, no backward compatibility required." Maintaining both protocols doubles testing and complexity. | Remove legacy code paths entirely. |
| **Custom `set_thinking_budget` control** | Explicitly out of scope per #996. ACP `configOptions` with `category: "thought_level"` replaces this. | Use ACP configOptions with thought_level category. |
| **Custom `rewind_files` support** | Explicitly out of scope per #996. This was a Claude-specific control request. | Drop the feature. Rewind is not part of ACP. |
| **Keeping legacy WebSocket message contracts** | Issue #996 allows user-visible behavior changes where they simplify architecture. | Define ACP-native delta event shapes. Frontend adapts. |
| **MCP server passthrough configuration** | ACP supports `mcpServers` in `session/new` for connecting agent-side MCP servers. FF does not need to proxy this. | Pass through if useful, but do not build UI for configuring agent MCP servers. |
| **Remote/HTTP agent transport** | ACP supports remote agents via HTTP/SSE. FF runs agents as local subprocesses. | Stdio only. Do not implement HTTP transport. |
| **unstable_resumeSession / unstable_forkSession** | These are unstable ACP methods. Too risky to depend on for a cutover milestone. | Skip entirely. If needed later, add as capability-gated features. |
| **Authentication flow** | ACP has an `authenticate` method for agents that require auth. Claude-code-acp uses env vars directly. Codex-acp handles auth differently. | Env vars for API keys. Do not build an in-app auth flow for ACP adapters. |
| **Per-field subscription filtering for config updates** | Over-engineering. ConfigOptions arrays are small. | Push full configOptions on every update. |
| **Terminal management via ACP** | ACP defines `terminal/create`, `terminal/output`, etc. for client-managed terminals. FF already has its own terminal domain. Codex-acp runs terminals internally (non-PTY mode). | Do not implement ACP terminal client methods. Agents manage their own terminals. |
| **File system operations via ACP** | ACP defines `fs/read_text_file`, `fs/write_text_file` as client capabilities. Claude-code-acp uses its own built-in MCP server. Codex handles files internally. | Declare `fs` capabilities as false in `clientCapabilities`. Agents handle files internally. |

## Feature Dependencies

```
[Provider launch config]
    |
    +--enables--> [ACP subprocess lifecycle]
                      |
                      +--enables--> [ClientSideConnection wiring]
                      |                 |
                      |                 +--enables--> [initialize handshake]
                      |                                   |
                      |                                   +--enables--> [session/new]
                      |                                   |                 |
                      |                                   |                 +--enables--> [session/prompt]
                      |                                   |                 |                 |
                      |                                   |                 |                 +--enables--> [session/cancel]
                      |                                   |                 |
                      |                                   |                 +--enables--> [configOptions-driven controls]
                      |                                   |                                   |
                      |                                   |                                   +--enables--> [Frontend config option UI]
                      |                                   |
                      |                                   +--enables--> [Capability-gated features]
                      |
                      +--enables--> [session/update notification handling]
                      |                 |
                      |                 +--enables--> [ACP event translation to FF deltas]
                      |                 |                 |
                      |                 |                 +--enables--> [Tool call status rendering]
                      |                 |                 +--enables--> [Agent thought rendering]
                      |                 |                 +--enables--> [Plan rendering]
                      |                 |                 +--enables--> [Slash command forwarding]
                      |                 |
                      |                 +--enables--> [Permission option selection]
                      |                 |                 |
                      |                 |                 +--enables--> [Frontend permission UI update]
                      |                 |
                      |                 +--enables--> [Config option update reactivity]
                      |                 |
                      |                 +--enables--> [Session file logging]
                      |
                      +--enables--> [Process management (stop/kill)]
                      |                 |
                      |                 +--enables--> [Health reporting]
                      |
                      +--enables--> [Unified runtime manager]

[session/load] --requires--> [session/new] + [Capability-gated features]
[unstable_listSessions] --requires--> [session/load]

[Legacy code removal] --requires--> ALL table stakes features working
```

### Critical Path

The dependency chain has a clear critical path:

1. Provider launch config + ACP subprocess lifecycle (foundation)
2. ClientSideConnection wiring + initialize handshake (protocol bootstrap)
3. session/new + session/prompt (basic interaction)
4. session/update notification handling + event translation (streaming content)
5. Permission option selection + config options (interactive features)
6. Frontend updates (permission UI, config option UI)
7. Legacy code removal (cleanup)

Steps 3-5 can partially overlap because `session/update` handling is needed to verify `session/prompt` works end-to-end.

## MVP Recommendation

### Phase 1: ACP Runtime Foundation

Build the core ACP runtime that can start a session and send/receive a single prompt. Validates the entire subprocess + ClientSideConnection + JSON-RPC pipeline end-to-end.

1. **Provider launch config** -- binary paths, env vars, pinned versions
2. **ACP subprocess lifecycle** -- spawn, stdio wiring, exit handling
3. **ClientSideConnection wiring** -- `toClient` callback, stream setup
4. **initialize handshake** -- capability exchange
5. **session/new** -- create session with cwd
6. **session/prompt + session/cancel** -- basic interaction loop
7. **session/update notification handling** -- receive and log all update types
8. **Session file logging** -- debug observability from day one

**Validation:** Can start a Claude ACP session, send a prompt, receive streamed response, see it logged.

### Phase 2: Event Translation + Permissions

Make the ACP events visible in the FF frontend and handle interactive flows.

1. **ACP event translation to FF delta events** -- map SessionUpdate variants
2. **Permission option selection** -- implement Client.requestPermission()
3. **Frontend permission UI update** -- render option choices
4. **Tool call status rendering** -- show tool lifecycle in chat
5. **Process management** -- clean stop/kill

**Validation:** Can interact with Claude via ACP with permission prompts working in UI.

### Phase 3: Config Options + Second Provider

Add configuration controls and bring Codex online through the same ACP runtime.

1. **configOptions-driven model/mode/reasoning controls** -- parse, store, send
2. **Frontend config option UI** -- render selectors by category
3. **Config option update reactivity** -- handle agent-pushed changes
4. **Codex ACP adapter integration** -- same runtime, different binary
5. **Unified runtime manager** -- single manager for both providers

**Validation:** Both providers work through ACP. Config options control model/reasoning for both.

### Phase 4: Cleanup + Polish

Remove legacy code and add differentiator features.

1. **Legacy code removal** -- protocol stacks, old handlers, old tests
2. **session/load** -- capability-gated session resume
3. **Health reporting** -- admin surfaces for per-session processes
4. **Capability-gated features** -- conditional UI based on agent capabilities

**Defer:** `unstable_listSessions`, `unstable_resumeSession`, `unstable_forkSession`, file location tracking, terminal client methods.

## ACP Protocol Reference

### Lifecycle Sequence

```
Client                              Agent (claude-code-acp / codex-acp)
  |                                    |
  |--- initialize ------------------>  |  (version, capabilities, clientInfo)
  |<-- InitializeResponse -----------  |  (version, capabilities, agentInfo, configOptions)
  |                                    |
  |--- session/new ----------------->  |  (cwd, mcpServers?)
  |<-- NewSessionResponse -----------  |  (sessionId)
  |                                    |
  |--- session/prompt -------------->  |  (sessionId, content[])
  |<== session/update ==============  |  (agent_message_chunk, tool_call, ...)
  |<== session/request_permission ==  |  (toolCall, options[])
  |--- RequestPermissionResponse --->  |  (outcome: selected, optionId)
  |<== session/update ==============  |  (tool_call_update, more chunks)
  |<-- PromptResponse ---------------  |  (stopReason: end_turn)
  |                                    |
  |--- session/set_config_option --->  |  (configId, value)
  |<-- SetConfigOptionResponse ------  |  (full configOptions[])
  |                                    |
  |=== session/cancel =============>  |  (notification, no response)
```

### SessionUpdate Variants

| Variant | Purpose | Maps to FF |
|---------|---------|------------|
| `agent_message_chunk` | Streamed text content | `stream_event` (content_block_start/delta) |
| `agent_thought_chunk` | Reasoning/thinking content | `stream_event` (thinking blocks) |
| `tool_call` | New tool invocation | `tool_use` + `stream_event` |
| `tool_call_update` | Status/result change on tool | `tool_progress` / `tool_use_summary` |
| `plan` | Structured plan with tasks | New delta event type |
| `config_options_update` | Config option changes | New delta event type |
| `current_mode_update` | Session mode changed | `status_update` |
| `available_commands_update` | Slash commands | `slash_commands` |
| `user_message_chunk` | History replay (session/load) | `agent_message` |

### Permission Option Kinds

| Kind | Meaning | UI Treatment |
|------|---------|-------------|
| `allow_once` | Allow this one time | Primary action button |
| `allow_always` | Allow and remember | Secondary action button |
| `reject_once` | Reject this one time | Reject button |
| `reject_always` | Reject and remember | Secondary reject button |

### ConfigOption Categories

| Category | Controls | Current FF Equivalent |
|----------|----------|----------------------|
| `mode` | Session operating mode (ask, architect, code) | `sendSetPermissionMode()` |
| `model` | Model selection | `sendSetModel()` |
| `thought_level` | Reasoning/thinking budget | `sendSetMaxThinkingTokens()` |
| Custom (`_prefix`) | Agent-specific options | None |

### ConfigOption Structure

```typescript
interface ConfigOption {
  id: string;            // Used in setSessionConfigOption
  name: string;          // Human-readable label
  description?: string;  // Tooltip text
  category?: 'mode' | 'model' | 'thought_level' | string;
  type: 'select';        // Only type currently supported
  currentValue: string;  // Active selection
  options: Array<{
    value: string;       // ID sent back to agent
    name: string;        // Display label
    description?: string;
  }>;
}
```

## Complexity Assessment

| Feature Area | Complexity | Rationale |
|-------------|------------|-----------|
| ACP subprocess + connection | MEDIUM | Standard child_process + JSON-RPC, but must handle backpressure, error recovery, and clean shutdown |
| Event translation | HIGH | Many SessionUpdate variants, each needs mapping to FF delta events. Two-way contract (ACP types -> FF types). Most code volume. |
| Permission UI change | HIGH | Fundamental UX change from boolean to multi-option. Affects chat handlers, WebSocket messages, frontend components, and pending request store. |
| Config option system | HIGH | Replaces three separate imperative controls (model, mode, thinking) with a single declarative system. New UI components, new state management, new WebSocket events. |
| Legacy removal | HIGH | Large surface area (~20 files). Must verify all call sites are migrated before removal. Risk of missed references. |
| session/load | MEDIUM | Conceptually simple but must handle history replay stream and capability gating. |
| Unified runtime manager | MEDIUM | Refactor of existing pattern. Two provider-specific managers become one generic manager. |

## Sources

- [Agent Client Protocol specification](https://agentclientprotocol.com/protocol/overview) -- protocol overview, session lifecycle, tool calls, permissions (HIGH confidence)
- [ACP Initialization spec](https://agentclientprotocol.com/protocol/initialization) -- capability negotiation, version exchange (HIGH confidence)
- [ACP Prompt Turn spec](https://agentclientprotocol.com/protocol/prompt-turn) -- prompt flow, stop reasons, cancellation (HIGH confidence)
- [ACP Session Config Options](https://agentclientprotocol.com/protocol/session-config-options) -- config option structure, categories, set flow (HIGH confidence)
- [ACP Tool Calls spec](https://agentclientprotocol.com/protocol/tool-calls) -- permission requests, option kinds, status lifecycle (HIGH confidence)
- [ACP Session Modes](https://agentclientprotocol.com/protocol/session-modes) -- mode switching, deprecation toward configOptions (HIGH confidence)
- [ACP Session Setup](https://agentclientprotocol.com/protocol/session-setup) -- session/new, session/load parameters and responses (HIGH confidence)
- [ACP Schema](https://agentclientprotocol.com/protocol/schema) -- full type definitions (HIGH confidence)
- [ClientSideConnection API](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html) -- TypeScript SDK v0.14.1 (HIGH confidence)
- [claude-code-acp repository](https://github.com/zed-industries/claude-code-acp) -- adapter architecture, permission hierarchy, event translation (HIGH confidence)
- [codex-acp repository](https://github.com/zed-industries/codex-acp) -- Rust adapter, terminal handling, auth methods (MEDIUM confidence)
- [Zed blog: Claude Code via ACP](https://zed.dev/blog/claude-code-via-acp) -- adapter design rationale (MEDIUM confidence)
- [Zed blog: Codex is Live](https://zed.dev/blog/codex-is-live-in-zed) -- Codex terminal architecture (MEDIUM confidence)
- [DeepWiki: claude-code-acp](https://deepwiki.com/zed-industries/claude-code-acp) -- detailed architecture, type mappings, permission system (MEDIUM confidence)
- Factory Factory codebase: `src/backend/domains/session/` -- existing protocol stack, permissions, event forwarding, runtime managers (HIGH confidence -- direct inspection)
- GitHub issue #996 -- scope definition, acceptance criteria (HIGH confidence)

---
*Feature research for: ACP-Only Cutover (v1.2)*
*Researched: 2026-02-13*
