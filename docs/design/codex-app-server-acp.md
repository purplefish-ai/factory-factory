# Design Doc: ACP ⇄ Codex App Server Adapter (v0.1)

## Summary

We will build a standalone **ACP Agent** that speaks **ACP JSON-RPC over stdio** to any ACP-compatible editor/client, and uses **`codex app-server`** as the backend engine by speaking **Codex app-server JSON-RPC over JSONL (stdio)**. The adapter translates ACP sessions + prompt turns into Codex **threads + turns**, relays Codex streaming events (messages, tool progress, diffs/plans) back as ACP `session/update` notifications, and bridges Codex approval requests into ACP `session/request_permission`.

This is a direct alternative to the existing Zed `codex-acp` adapter, which wraps the **Codex CLI** rather than the app server. ([GitHub][1])

---

## Context and Motivation

### Why not keep using `zed-industries/codex-acp`?

The existing adapter is explicitly “an ACP adapter around the Codex CLI.” ([GitHub][1])
Wrapping an interactive CLI tends to be fragile (PTY quirks, prompt parsing, stream synchronization). Your experience (“buggy”) aligns with the typical failure modes of CLI-driven integrations.

### Why `codex app-server` is the right backend

OpenAI describes `codex app-server` as **the interface Codex uses to power rich clients** (e.g., the official VS Code extension), including **auth, conversation history, approvals, and streamed agent events**. ([OpenAI Developers][2])
It uses a bidirectional JSON-RPC protocol over JSONL/stdin/stdout (with a small on-the-wire difference: it omits the `"jsonrpc":"2.0"` header). ([OpenAI Developers][2])
It also supports **schema generation** pinned to the installed Codex version, which is a major stability win. ([OpenAI Developers][2])

### ACP fit

ACP standardizes editor↔agent communication (similar to LSP’s role for language servers) and is designed for local agents as subprocesses communicating via JSON-RPC over stdio. ([Agent Client Protocol][3])

---

## Goals

### Functional goals

1. Implement ACP baseline: `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/update` notifications. ([Agent Client Protocol][4])
2. Support `session/load` (optional but recommended) and faithfully replay history via `session/update` notifications. ([Agent Client Protocol][5])
3. Stream agent output: plans, message chunks, tool call lifecycle updates. ([Agent Client Protocol][6])
4. Bridge approvals: Codex approval requests (commands, file changes, and app tool calls) → ACP `session/request_permission` → Codex accept/decline. ([OpenAI Developers][2])
5. Expose session config options (ACP `configOptions`) for mode/model/thought level and map them to Codex `turn/start` overrides (`model`, `effort`, etc.). ([Agent Client Protocol][7])

### Non-functional goals

* Reliability: deterministic translation layer, schema-driven decoding of Codex messages.
* Performance: streaming end-to-end with backpressure-safe buffering.
* Debuggability: structured logs + correlation IDs (sessionId/threadId/turnId/itemId).

---

## Non-goals (v0.1)

* Remote ACP transports (HTTP/WebSocket for ACP). We implement **stdio ACP** first (common for local agents). ([Agent Client Protocol][3])
* Perfect parity with all Codex “rich client” UI features (e.g., review mode UX, advanced terminals UX). We design extension points for later.

---

## Key Protocol References

### ACP

* Initialization and capability negotiation: `initialize` request/response. ([Agent Client Protocol][4])
* Session setup: `session/new`, `session/load`, replay semantics. ([Agent Client Protocol][5])
* Prompt turn lifecycle: `session/prompt`, streaming `session/update`, stop reasons, cancellation semantics. ([Agent Client Protocol][6])
* Content blocks: `text`, `image`, embedded `resource`, `resource_link`. ([Agent Client Protocol][8])
* Tool call reporting + permission requests: tool kinds/statuses, `session/request_permission`. ([Agent Client Protocol][9])
* Session config options: `configOptions`, `session/set_config_option`, full-state response requirement. ([Agent Client Protocol][7])

### Codex app-server

* Protocol: JSON-RPC over JSONL stdio; header omitted on-wire. ([OpenAI Developers][2])
* Required handshake: `initialize` request then `initialized` notification (rejects calls before). ([OpenAI Developers][2])
* Core primitives: thread/turn/item; streaming events `item/started`, `item/*/delta`, `item/completed`, `turn/completed`. ([GitHub][10])
* Turn start & overrides: `turn/start` fields include `cwd`, `approvalPolicy`, `sandboxPolicy`, `model`, `effort`, `personality`, etc. ([OpenAI Developers][2])
* Cancellation: `turn/interrupt` ends turn with status `"interrupted"`. ([OpenAI Developers][2])
* Approvals: command/file/tool approvals and accept/decline response patterns. ([OpenAI Developers][2])
* Schema generation: `generate-ts` and `generate-json-schema`. ([OpenAI Developers][2])
* Model catalog: `model/list` returns available models + effort options + input modalities. ([OpenAI Developers][2])
* MCP config reload and status introspection: `config/mcpServer/reload`, `mcpServerStatus/list`. ([OpenAI Developers][2])

---

## Architecture

### High-level components

1. **ACP Server (stdio JSON-RPC)**

   * Reads ACP requests from stdin, writes responses/notifications to stdout.
   * Implements ACP methods and emits `session/update`.

2. **Codex Client**

   * Spawns `codex app-server` as a subprocess.
   * Speaks JSON-RPC 2.0 **without** `"jsonrpc":"2.0"` field (Codex wire format), newline-delimited JSON. ([OpenAI Developers][2])
   * Handles handshake: `initialize` then `initialized`. ([OpenAI Developers][2])

3. **Translator / Router**

   * Maintains mapping: ACP `sessionId` ↔ Codex `threadId`
   * Routes Codex notifications by `threadId` → correct ACP session

4. **Turn Orchestrator**

   * Enforces at most one in-flight turn per ACP session (v0.1).
   * Converts ACP prompt blocks into Codex `turn/start.input[]`.
   * Collects Codex streaming events and forwards to ACP updates.

5. **Approval Bridge**

   * Converts Codex approval requests → ACP `session/request_permission`
   * Converts ACP outcome → Codex accept/decline response

6. **Persistence Layer**

   * Stores `{ sessionId, threadId, cwd, config defaults, timestamps }`
   * Enables `session/load` by rehydrating thread history via `thread/read includeTurns`. ([OpenAI Developers][2])

---

## Data Model

### SessionRecord

```json
{
  "sessionId": "sess_abc123",
  "threadId": "thr_123",
  "cwd": "/abs/path/to/project",
  "createdAt": 1730000000,
  "updatedAt": 1730000123,
  "defaults": {
    "mode": "ask",
    "model": "gpt-5.2-codex",
    "effort": "medium",
    "personality": "friendly",
    "approvalPolicy": "unlessTrusted",
    "sandboxPolicy": {
      "type": "workspaceWrite",
      "writableRoots": ["/abs/path/to/project"],
      "networkAccess": true
    }
  }
}
```

### In-memory session state

* `activeTurn: { turnId, inFlight, toolCallsByItemId } | null`
* `pendingApprovals: Map<approvalRequestId, PendingApproval>`
* `configOptionsState: full ACP configOptions array` (must always respond with full state on changes). ([Agent Client Protocol][7])

---

## Protocol Bridging

## 1) Startup Handshake

### Sequence

1. ACP Client → Adapter: `initialize` (ACP).
2. Adapter → ACP Client: `initialize` response with capabilities.
3. Adapter spawns `codex app-server`.
4. Adapter → Codex: `initialize { clientInfo, capabilities? }`
5. Adapter → Codex: `initialized` notification

Codex requires the initialize handshake before any other request on that connection. ([OpenAI Developers][2])
ACP requires `initialize` negotiation before sessions. ([Agent Client Protocol][4])

### ACP capabilities to advertise (recommended)

* `loadSession: true` (if we implement persistence + replay). ([Agent Client Protocol][4])
* `promptCapabilities`:

  * `image: true` if we implement ACP images → Codex localImage
  * `embeddedContext: true` if we accept embedded resource blocks and pass them as text context ([Agent Client Protocol][4])
* `mcp.http`: only if we implement ACP-provided MCP HTTP servers (optional; see MCP section). ([Agent Client Protocol][4])

---

## 2) Session Creation: `session/new` → `thread/start`

### ACP contract

Client calls `session/new { cwd, mcpServers }` and agent returns a unique `sessionId`. ([Agent Client Protocol][5])

### Codex mapping

Adapter calls `thread/start` and records returned `thread.id`. Codex thread methods and lifecycle are standard. ([OpenAI Developers][2])

### Implementation details

* Generate ACP `sessionId` as `sess_<uuidv7>` (uuidv7 preferred for ordering).
* Call `thread/start` with initial defaults:

  * `model`
  * `cwd`
  * `approvalPolicy`
  * `personality`
  * (optional) `sandbox` or `sandboxPolicy` depending on your chosen shape (Codex supports turn-level `sandboxPolicy` shown in examples). ([OpenAI Developers][2])
* Persist mapping.

### Response payload

Return:

* `sessionId`
* optional `configOptions` (preferred over legacy `modes`). ([Agent Client Protocol][7])

---

## 3) Session Load: `session/load` → `thread/resume` + replay

### ACP contract

If `loadSession` is supported, the agent must:

1. replay full conversation via `session/update` notifications, then
2. respond to `session/load` with `result: null`. ([Agent Client Protocol][5])

### Codex mapping

* `thread/resume` to reopen the thread
* `thread/read { includeTurns: true }` to fetch history for replay ([OpenAI Developers][2])

### Replay mapping rules

For each Codex turn’s items:

* User message items → ACP `session/update: user_message_chunk`
* Agent message items → ACP `session/update: agent_message_chunk`
* Tool-like items → ACP `session/update: tool_call` and `tool_call_update` (optional but recommended for rich clients)

ACP replay examples use `user_message_chunk` then `agent_message_chunk`. ([Agent Client Protocol][5])

---

## 4) Prompt Turn: `session/prompt` → `turn/start`

### ACP contract

Client sends `session/prompt` with an array of MCP ContentBlocks. Agent streams output via `session/update` (plan, message chunks, tool calls), then returns a `stopReason` (e.g., `end_turn`, `cancelled`). ([Agent Client Protocol][6])

### Codex mapping

* Call `turn/start { threadId, input: [...] , overrides... }`
* Stream Codex notifications until `turn/completed` ([OpenAI Developers][2])

### Content conversion (ACP → Codex input[])

ACP content types are MCP ContentBlocks. ([Agent Client Protocol][8])

**Mapping**

1. ACP `{"type":"text","text":...}` → Codex `{ type:"text", text:"..." }`
2. ACP `{"type":"image","mimeType":...,"data":...}` → write temp file + Codex `{ type:"localImage", path:"/tmp/acp_<id>.png" }`

   * ACP images are base64 in `data`. ([Agent Client Protocol][8])
   * Codex models list includes `inputModalities` which can be checked to ensure image support. ([OpenAI Developers][2])
3. ACP embedded `resource` → convert into a Codex text block with a structured wrapper:

   ```text
   [ACP_RESOURCE uri="file:///..." mime="text/x-python"]
   ...resource.text...
   [/ACP_RESOURCE]
   ```

   ACP embedded resource is the preferred way to include file contents. ([Agent Client Protocol][8])
4. ACP `resource_link` → convert into a Codex text block referencing the URI:

   ```text
   [ACP_RESOURCE_LINK uri="file:///..." name="..."]
   [/ACP_RESOURCE_LINK]
   ```

   ACP resource links represent resources the agent can access. ([Agent Client Protocol][8])

### Applying per-turn overrides

From Codex `turn/start`, we can override:

* `cwd`
* `approvalPolicy`
* `sandboxPolicy`
* `model`
* `effort`
* `personality`
  (plus others like `summary`, `outputSchema`) ([OpenAI Developers][2])

The adapter should:

* Apply session defaults (from configOptions) to each `turn/start`
* Allow overrides via ACP slash commands later (optional extension)

---

## 5) Streaming: Codex notifications → ACP `session/update`

### Codex event model

Items emit lifecycle:

* `item/started` (full item)
* deltas like `item/agentMessage/delta`, `item/commandExecution/outputDelta`, etc.
* `item/completed` (final item state)
  Turns complete via `turn/completed`. ([OpenAI Developers][2])

### ACP streaming model

Agent emits:

* `session/update: plan`
* `session/update: agent_message_chunk`
* `session/update: tool_call` and `tool_call_update` ([Agent Client Protocol][6])

### Mapping rules

#### A) Agent text

* Codex: `item/agentMessage/delta`
* ACP: `session/update: agent_message_chunk` with `{type:"text", text: <delta>}` ([OpenAI Developers][2])

#### B) Plan

Codex supports plan streaming (including plan deltas). ([OpenAI Developers][2])
ACP plan format is a list of entries with `content`, `priority`, `status`. ([Agent Client Protocol][6])

**Implementation strategy**

* If Codex emits structured plan steps: map directly.
* If Codex emits plan text deltas only: accumulate and periodically emit ACP `plan` with a single entry containing the plan text.

#### C) Tool calls (Codex items → ACP tool calls)

ACP tool call kinds include: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`. ([Agent Client Protocol][9])
ACP tool call statuses include: `pending`, `in_progress`, `completed`, `failed`. ([Agent Client Protocol][9])

**ToolCallId scheme**

* `toolCallId = "codex:<threadId>:<turnId>:<itemId>"`

**Item type mapping**

* `commandExecution` → ACP `kind:"execute"`
* `fileChange` → ACP `kind:"edit"` (or `move/delete` if you detect a rename/delete operation in change set)
* `webSearch` → ACP `kind:"search"`
* `mcpToolCall` → ACP `kind:"fetch"` (or `other` if you want to reserve `fetch` for HTTP)
* `plan`/`reasoning` items → ACP `kind:"think"` (optional to surface)

**Lifecycle mapping**

1. On Codex `item/started` for tool-like item:

   * emit ACP `session/update: tool_call` with `status:"pending"`
2. When execution begins (often immediately after started; or when approval is granted):

   * emit ACP `tool_call_update` with `status:"in_progress"`
3. Stream output deltas:

   * `item/commandExecution/outputDelta` → ACP `tool_call_update.content += text` ([OpenAI Developers][2])
4. On `item/completed`:

   * map `completed` → `completed`
   * map `failed` → `failed`
   * map `declined` → `failed` **or** `completed` with content “declined” (pick one policy and keep consistent; recommended: `failed` for declined)
   * attach:

     * `rawInput`: original item request
     * `rawOutput`: final item result
     * `locations`: file URIs touched (for `fileChange`) ([Agent Client Protocol][9])

---

## 6) Approvals: Codex request → ACP permission → Codex response

### Codex approvals

Codex may require approval for:

* command execution (`item/commandExecution/requestApproval`)
* file changes (`item/fileChange/requestApproval`)
* app tool calls via `tool/requestUserInput` (side-effects) ([OpenAI Developers][2])

Codex sends a **server-initiated JSON-RPC request** and expects `{ decision: "accept" | "decline" }`. ([OpenAI Developers][2])

### ACP permission requests

ACP agent can call `session/request_permission` with options like `allow_once` and `reject_once`. ([Agent Client Protocol][9])

### Adapter behavior

1. When Codex requests approval:

   * ensure an ACP tool call exists for the underlying item (so the UI has context)
   * call ACP `session/request_permission` with:

     * `toolCall` referencing `toolCallId`
     * options:

       * Allow once (`allow_once`)
       * Reject (`reject_once`)
         (optionally add Allow always if your client supports it; ACP supports richer options patterns) ([Agent Client Protocol][9])
2. Wait for ACP client response.
3. Respond to Codex request:

   * if allow → `{ decision:"accept" }`
   * else → `{ decision:"decline" }` ([OpenAI Developers][2])
4. Update the ACP tool call:

   * on accept: `status:"in_progress"`
   * on decline: `status:"failed"` and add text content indicating decline.

---

## 7) Cancellation: `session/cancel` → `turn/interrupt`

### ACP cancellation semantics

Client sends `session/cancel`; agent must stop operations and respond to the pending `session/prompt` with `stopReason:"cancelled"`. ([Agent Client Protocol][6])

### Codex mapping

Call `turn/interrupt { threadId, turnId }`. On success, Codex finishes with status `"interrupted"`. ([OpenAI Developers][2])

### Implementation detail

* Maintain `activeTurn.turnId` for each session.
* On cancel:

  * call Codex `turn/interrupt`
  * continue to relay any final `item/completed` and `turn/completed`
  * resolve ACP `session/prompt` with `stopReason:"cancelled"` ([Agent Client Protocol][6])

---

## Session Config Options

ACP config options are preferred over legacy session modes and must be returned as full state on changes. ([Agent Client Protocol][7])
ACP reserves categories `mode`, `model`, `thought_level`. ([Agent Client Protocol][7])

### Options to implement (v0.1)

1. **Mode** (`id:"mode"`, `category:"mode"`)

* `ask`: request permission before side effects
* `code`: allow tools without extra prompts (subject to Codex approval policy)

2. **Model** (`id:"model"`, `category:"model"`)

* Populate options by calling Codex `model/list` and mapping `displayName` + `id`. ([OpenAI Developers][2])

3. **Thought level** (`id:"thought_level"`, `category:"thought_level"`)

* `low|medium|high` mapped to Codex `effort`. ([OpenAI Developers][2])

4. **Personality** (optional in v0.1)

* `friendly|pragmatic|none` (Codex supports these). ([GitHub][10])

### Applying config options

* Store selected values in session defaults.
* Apply them to every `turn/start` (model/effort/personality, approvalPolicy, etc.). ([OpenAI Developers][2])
* Implement ACP `session/set_config_option`:

  * validate value
  * update defaults
  * return **complete** `configOptions` state. ([Agent Client Protocol][7])

---

## MCP Servers Strategy

ACP `session/new` includes `mcpServers` and states all agents must support stdio MCP transport (HTTP optional via capabilities). ([Agent Client Protocol][5])
Codex app-server can reload MCP configuration from disk using `config/mcpServer/reload` and list MCP server status via `mcpServerStatus/list`. ([OpenAI Developers][2])

### v0.1 Recommended approach (implementable and robust)

**Implement client-provided MCP servers by writing Codex config on disk + reload.**

Flow:

1. On `session/new` (or `session/load`), take ACP `mcpServers[]`.
2. Convert to Codex config format and write to a controlled config layer (e.g., a per-adapter user config file or project config file).
3. Call `config/mcpServer/reload` so Codex refreshes configured MCP servers. ([OpenAI Developers][2])
4. Optionally call `mcpServerStatus/list` and expose status via an ACP agent message chunk when debugging. ([OpenAI Developers][2])

Notes:

* If you prefer not to manage config files at first, you can ship v0.1 with a “MCP must already be configured for Codex” policy and add the bridge later. The adapter remains ACP-compliant but less featureful.

---

## Error Handling

### Codex error events

If a turn fails, Codex emits an `error` event and finishes the turn with `status:"failed"`; error info can include upstream HTTP status codes. ([OpenAI Developers][2])

### Backpressure / overload

The open-source app-server README notes bounded queues and a retryable JSON-RPC error code `-32001` with message `"Server overloaded; retry later."` when ingress is saturated. ([GitHub][10])

### Adapter policies

* If Codex returns `-32001` for idempotent requests (e.g., `model/list`), retry with exponential backoff + jitter.
* For non-idempotent requests (`turn/start`), do **not** blindly retry (avoid duplicated actions). Instead:

  * emit ACP `agent_message_chunk` indicating failure and
  * return `stopReason:"end_turn"` or an ACP error response (choose one; recommended: return `end_turn` with a clear message for UX consistency).

---

## Concurrency and Routing

### In-flight turn constraints (v0.1)

* One active `session/prompt` at a time per sessionId.
* If a second `session/prompt` arrives while a turn is in progress:

  * either reject with JSON-RPC error
  * or queue it (recommended: reject in v0.1 for simplicity)

### Routing Codex notifications

Codex will stream notifications for turns/items; they include thread/turn/item identifiers. The adapter must:

* maintain `threadId -> sessionId` mapping
* forward events only to the corresponding ACP session via `session/update`.

---

## Implementation Details

## Transport: JSON-RPC framing

### ACP side

* Standard JSON-RPC 2.0 framing with `"jsonrpc":"2.0"`. ([Agent Client Protocol][4])
* stdio; one JSON object per line (recommended).

### Codex side

* JSON-RPC 2.0 semantics over JSONL stdio
* **No `"jsonrpc":"2.0"` header on messages**. ([OpenAI Developers][2])

Implementation: two serializers:

* `serializeAcp(msg)` includes `"jsonrpc":"2.0"`
* `serializeCodex(msg)` omits `"jsonrpc"` field

---

## Codex schema generation and typing

Use schema generation to pin message shapes to your installed Codex version:

* `codex app-server generate-ts --out ./schemas`
* `codex app-server generate-json-schema --out ./schemas` ([OpenAI Developers][2])

Recommended build strategy:

* CI step generates schema and commits it (or caches as artifact).
* Runtime code validates Codex messages (especially approvals + item types) against generated schema.

---

## Suggested Project Structure

Language-agnostic module layout:

```
/src
  /acp
    transport.ts|rs
    handlers.ts|rs
    types.ts|rs
  /codex
    process.ts|rs
    rpc.ts|rs
    types.ts|rs        (generated or mapped from generated schema)
  /bridge
    session_manager.ts|rs
    turn_orchestrator.ts|rs
    translator.ts|rs
    approval_bridge.ts|rs
    mcp_bridge.ts|rs
  /storage
    persistence.ts|rs
  /util
    logger.ts|rs
    ids.ts|rs
    tempfiles.ts|rs
main.ts|rs
```

---

## ACP Method Specs (Adapter Responsibilities)

### `initialize` (ACP)

Input: `{ protocolVersion, clientCapabilities, clientInfo }`
Output: `{ protocolVersion, agentCapabilities, agentInfo, authMethods }` ([Agent Client Protocol][4])

Adapter requirements:

* Negotiate protocolVersion
* Advertise:

  * `loadSession` if implemented ([Agent Client Protocol][4])
  * `promptCapabilities` (`image`, `embeddedContext`) depending on support ([Agent Client Protocol][4])

### `session/new` (ACP)

Input: `{ cwd, mcpServers }` ([Agent Client Protocol][5])
Output: `{ sessionId, configOptions? }`

Adapter actions:

* start Codex thread
* persist mapping
* initialize configOptions state

### `session/load` (ACP, optional)

Input: `{ sessionId, cwd, mcpServers }` ([Agent Client Protocol][5])
Output: `null` after replay

Adapter actions:

* restore session record
* `thread/resume`
* `thread/read includeTurns:true`
* replay via `session/update` user/agent/tool calls ([Agent Client Protocol][5])

### `session/prompt` (ACP)

Input: `{ sessionId, prompt:[ContentBlock...] }` ([Agent Client Protocol][6])
Output: `{ stopReason }` (usually `end_turn` or `cancelled`) ([Agent Client Protocol][6])

Adapter actions:

* translate content blocks → Codex `turn/start`
* stream events → `session/update`
* finalize with stopReason

### `session/cancel` (ACP)

Input: `{ sessionId }` ([Agent Client Protocol][6])
Adapter actions:

* if in-flight, call Codex `turn/interrupt` ([OpenAI Developers][2])
* ensure `session/prompt` resolves with `stopReason:"cancelled"` ([Agent Client Protocol][6])

### `session/set_config_option` (ACP)

Input: `{ sessionId, configId, value }` ([Agent Client Protocol][7])
Output: `{ configOptions:[...] }` full state ([Agent Client Protocol][7])

Adapter actions:

* update session defaults
* return full configOptions state (not a patch) ([Agent Client Protocol][7])

---

## Codex RPC Usage

### Required handshake

Send `initialize` then `initialized`. Codex rejects requests before this. ([OpenAI Developers][2])

### Thread lifecycle

* `thread/start` for new sessions
* `thread/resume` to continue
* `thread/read includeTurns:true` for replay ([OpenAI Developers][2])

### Turn lifecycle

* `turn/start` with input and overrides ([OpenAI Developers][2])
* `turn/interrupt` for cancellation ([OpenAI Developers][2])

### Streaming events

Listen continuously for:

* `item/started`
* `item/*/delta` (agentMessage, command output, fileChange output)
* `item/completed`
* `turn/completed` ([OpenAI Developers][2])

### Models

Call `model/list` to populate ACP configOptions for model/effort and to know if image inputs are supported. ([OpenAI Developers][2])

---

## Observability

### Logging (minimum)

Log structured events with:

* `sessionId`
* `threadId`
* `turnId`
* `itemId`
* `toolCallId`
* `method` (ACP or Codex)
* `latency_ms` for RPC calls

### Debug endpoint (optional)

Implement an ACP slash command later (or just a special prompt keyword) that causes the adapter to:

* call `mcpServerStatus/list` and print a human-readable summary as `agent_message_chunk`. ([OpenAI Developers][2])

---

## Security and Workspace Boundaries

ACP states `cwd` must be absolute and should serve as a boundary for tool operations. ([Agent Client Protocol][5])
Codex `turn/start` supports `sandboxPolicy` and `approvalPolicy` and can restrict writable roots. ([OpenAI Developers][2])

v0.1 defaults:

* `sandboxPolicy.type = "workspaceWrite"`
* `writableRoots = [cwd]`
* `networkAccess = true` (configurable later via configOptions or env)

---

## Testing Plan

### Unit tests

* ACP↔Codex content mapping (text/image/resource/resource_link)
* Tool call lifecycle mapping for each item type
* Permission flow mapping (accept/decline/cancel)
* Config option state transitions (must return full state)

### Integration tests (golden traces)

Record + replay:

1. Basic prompt: message streaming + end_turn
2. Command execution requiring approval
3. File change requiring approval
4. Cancellation mid-turn
5. Session persistence: `session/new` → prompt → restart adapter → `session/load` → verify replay ordering ([Agent Client Protocol][5])

---

## Milestones

### Milestone A — MVP Chat + Streaming

* ACP: initialize/session/new/session/prompt/session/update/session/cancel
* Codex: handshake, thread/start, turn/start, agentMessage deltas, turn completion ([OpenAI Developers][2])

### Milestone B — Tool Calls + Approvals

* Map commandExecution/fileChange/mcpToolCall/webSearch items to ACP tool calls
* Bridge approvals via ACP `session/request_permission` ([OpenAI Developers][2])

### Milestone C — Persistence + session/load replay

* Store sessionId↔threadId
* Implement `thread/read includeTurns:true` → replay `session/update` history ([GitHub][10])

### Milestone D — MCP bridge + config options

* Write MCP servers into Codex config + call `config/mcpServer/reload` ([OpenAI Developers][2])
* Add `configOptions`: mode/model/thought_level ([Agent Client Protocol][7])

---

## Acceptance Criteria

1. Any ACP client can connect, initialize, create a session, prompt, see streamed output, and cancel. ([Agent Client Protocol][4])
2. Tool executions show up as ACP tool calls with correct kinds/status transitions and streamed output. ([Agent Client Protocol][9])
3. When Codex requests approvals, the adapter asks the client via ACP permission request and resumes/declines correctly. ([OpenAI Developers][2])
4. `session/load` replays full history in correct order and returns `null` after replay. ([Agent Client Protocol][5])
5. ACP `session/set_config_option` returns full config state and changes are reflected in subsequent turns. ([Agent Client Protocol][7])

---

## Appendix A: Reference Links (copy/paste)

```text
ACP Introduction:
https://agentclientprotocol.com/get-started/introduction

ACP Protocol:
https://agentclientprotocol.com/protocol/initialization
https://agentclientprotocol.com/protocol/session-setup
https://agentclientprotocol.com/protocol/prompt-turn
https://agentclientprotocol.com/protocol/content
https://agentclientprotocol.com/protocol/tool-calls
https://agentclientprotocol.com/protocol/session-config-options

Zed codex-acp (CLI adapter reference point):
https://github.com/zed-industries/codex-acp

Codex app-server docs:
https://developers.openai.com/codex/app-server/

Codex app-server open-source README:
https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
```


[1]: https://github.com/zed-industries/codex-acp "GitHub - zed-industries/codex-acp"
[2]: https://developers.openai.com/codex/app-server/ "Codex App Server"
[3]: https://agentclientprotocol.com/get-started/introduction "Introduction - Agent Client Protocol"
[4]: https://agentclientprotocol.com/protocol/initialization "Initialization - Agent Client Protocol"
[5]: https://agentclientprotocol.com/protocol/session-setup "Session Setup - Agent Client Protocol"
[6]: https://agentclientprotocol.com/protocol/prompt-turn "Prompt Turn - Agent Client Protocol"
[7]: https://agentclientprotocol.com/protocol/session-config-options "Session Config Options - Agent Client Protocol"
[8]: https://agentclientprotocol.com/protocol/content "Content - Agent Client Protocol"
[9]: https://agentclientprotocol.com/protocol/tool-calls "Tool Calls - Agent Client Protocol"
[10]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md "raw.githubusercontent.com"
