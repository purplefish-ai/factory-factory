# Technology Stack: ACP-Only Provider Runtime

**Project:** Replace custom Claude NDJSON + Codex app-server protocols with ACP adapters
**Researched:** 2026-02-13

## Executive Summary

The ACP cutover adds **three npm packages** and removes custom protocol glue for both providers. The ACP TypeScript SDK (`@agentclientprotocol/sdk`) provides the `ClientSideConnection` class that manages JSON-RPC over stdio to any ACP-compliant agent subprocess. The two Zed adapter packages (`@zed-industries/claude-code-acp` and `@zed-industries/codex-acp`) are spawned as subprocesses -- one per FF session -- and spoken to entirely via the ACP SDK's client API. The project's existing Zod v4.3.6 is compatible with all three packages. No other new dependencies are needed.

**IMPORTANT:** The `@zed-industries/agent-client-protocol` package is **deprecated** (since 2025-10-10). It has been renamed to `@agentclientprotocol/sdk`. All references must use the new package name.

## Recommended Stack

### New Dependencies (Production)

| Package | Version | Purpose | Why This Version |
|---------|---------|---------|------------------|
| `@agentclientprotocol/sdk` | `0.14.1` | ACP client runtime: `ClientSideConnection`, `ndJsonStream`, protocol types, Zod schemas | Latest stable. Actively maintained (published 2026-02-05). Peer dep: `zod ^3.25.0 \|\| ^4.0.0` -- compatible with project's Zod 4.3.6. |
| `@zed-industries/claude-code-acp` | `0.16.1` | Claude Code ACP adapter binary (spawned as subprocess) | Latest stable (published 2026-02-10). Active release cadence (~weekly). Binary at `claude-code-acp` in node_modules/.bin. |
| `@zed-industries/codex-acp` | `0.9.2` | Codex ACP adapter binary (spawned as subprocess) | Latest stable (published 2026-02-05). Platform-specific native binary resolved via optional deps. Binary at `codex-acp` in node_modules/.bin. |

**Confidence: HIGH** -- All versions verified via `npm view` on 2026-02-13. All three packages are Apache-2.0 licensed.

### Transitive Dependencies (Brought by claude-code-acp)

These are NOT direct dependencies of Factory Factory. Listed for awareness only -- they come in through `@zed-industries/claude-code-acp`:

| Package | Version | What It Is |
|---------|---------|------------|
| `@anthropic-ai/claude-agent-sdk` | `0.2.38` | Anthropic's Claude Agent SDK -- used internally by claude-code-acp to talk to Claude. Peer dep: `zod ^4.0.0`. |
| `@modelcontextprotocol/sdk` | `1.26.0` | MCP SDK -- used by claude-code-acp for MCP server relay. |
| `@agentclientprotocol/sdk` | `0.14.1` | Same ACP SDK we install directly (deduplicates). |
| `diff` | `8.0.3` | Text diffing for edit review. |
| `minimatch` | `10.1.2` | Glob matching. |

### Codex ACP Platform Binaries

`@zed-industries/codex-acp` is a thin JS launcher that resolves a platform-specific native binary. The appropriate binary installs automatically via optional dependencies:

| Platform | Optional Package |
|----------|-----------------|
| macOS ARM64 | `@zed-industries/codex-acp-darwin-arm64` |
| macOS x64 | `@zed-industries/codex-acp-darwin-x64` |
| Linux ARM64 | `@zed-industries/codex-acp-linux-arm64` |
| Linux x64 | `@zed-industries/codex-acp-linux-x64` |
| Windows ARM64 | `@zed-industries/codex-acp-win32-arm64` |
| Windows x64 | `@zed-industries/codex-acp-win32-x64` |

**Confidence: HIGH** -- Verified from npm package metadata.

### Existing Dependencies (No Version Changes Needed)

| Technology | Current Version | Role in ACP Integration |
|------------|----------------|------------------------|
| `zod` | `^4.3.6` (installed: 4.3.6) | Peer dependency for both `@agentclientprotocol/sdk` (accepts `^3.25.0 \|\| ^4.0.0`) and `@anthropic-ai/claude-agent-sdk` (accepts `^4.0.0`). Already satisfied. |
| `node:child_process` | Node.js built-in | `spawn()` for ACP adapter subprocesses. Already used for Claude CLI and Codex app-server. |
| `node:stream` | Node.js built-in | `Writable.toWeb()` / `Readable.toWeb()` to convert Node.js subprocess stdio to Web Streams for `ndJsonStream()`. |
| `tree-kill` | `^1.2.2` | Process group cleanup on session stop. Already in deps. |
| `ws` | `^8.19.0` | WebSocket push to frontend (unchanged). |

**Confidence: HIGH** -- All verified from project `package.json`.

## ACP SDK API Surface (What We Actually Use)

### Core Import

```typescript
import * as acp from '@agentclientprotocol/sdk';
// Or selective imports:
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Stream,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SetSessionConfigOptionRequest,
  type CancelNotification,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
```

### ClientSideConnection Class

```typescript
// Constructor
new ClientSideConnection(
  toClient: (agent: Agent) => Client,  // Factory: receives Agent info, returns Client implementation
  stream: Stream                        // From ndJsonStream()
): ClientSideConnection;

// Properties
connection.signal: AbortSignal;   // Aborts when connection closes
connection.closed: Promise<void>; // Resolves when connection closes

// Methods -- Agent-bound (Factory Factory calls these TO the agent)
connection.initialize(params: InitializeRequest): Promise<InitializeResponse>;
connection.newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
connection.loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;  // If agent supports it
connection.prompt(params: PromptRequest): Promise<PromptResponse>;
connection.cancel(params: CancelNotification): Promise<void>;
connection.setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
connection.setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;

// Unstable methods (use with caution, API may change)
connection.unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
connection.unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
connection.unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
connection.unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse>;

// Extension methods (for custom protocol extensions)
connection.extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
connection.extNotification(method: string, params: Record<string, unknown>): Promise<void>;
```

### Client Interface (Factory Factory implements this -- receives calls FROM the agent)

```typescript
interface Client {
  // REQUIRED: Agent asks for permission to use a tool
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;

  // REQUIRED: Agent sends session progress updates (streaming)
  sessionUpdate(params: SessionNotification): Promise<void>;

  // OPTIONAL: File system access (if advertised in clientCapabilities)
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;

  // OPTIONAL: Terminal management (if advertised)
  createTerminal?(params): Promise<...>;
  terminalOutput?(params): Promise<void>;
  waitForTerminalExit?(params): Promise<...>;
  killTerminal?(params): Promise<...>;
  releaseTerminal?(params): Promise<void>;
}
```

### ndJsonStream Helper

```typescript
function ndJsonStream(
  output: WritableStream<Uint8Array>,  // stdin of subprocess (writable for us)
  input: ReadableStream<Uint8Array>,   // stdout of subprocess (readable for us)
): Stream;  // { writable: WritableStream<AnyMessage>, readable: ReadableStream<AnyMessage> }
```

Converts subprocess stdio to the `Stream` type that `ClientSideConnection` requires. Uses newline-delimited JSON (JSON-RPC 2.0).

### Session Update Types (Discriminated Union)

The `SessionNotification.update` field is a discriminated union on `sessionUpdate`:

| `sessionUpdate` Value | Purpose | Key Fields |
|----------------------|---------|------------|
| `agent_message_chunk` | Streaming text/image from agent | `content: { type: 'text', text } \| { type: 'image', ... }` |
| `agent_thought_chunk` | Thinking/reasoning content | `content` |
| `user_message_chunk` | Echo of user message | `content` |
| `tool_call` | Agent starts a tool call | `title`, `status`, `toolCallId`, `toolName` |
| `tool_call_update` | Tool call status change | `toolCallId`, `status` |
| `plan` | Agent's execution plan | Plan entries |
| `available_commands_update` | Slash commands changed | Command list |
| `mode_change` | Agent mode switched | New mode |
| `config_options_update` | Config options changed | Updated config options (model, reasoning, etc.) |

**Confidence: HIGH** -- Verified from ACP SDK TypeScript docs and official protocol specification.

## Subprocess Spawn Pattern

### How to Spawn an ACP Adapter

```typescript
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// 1. Resolve binary path from node_modules
const command = 'claude-code-acp';  // or 'codex-acp'
// Both installed as bins via their npm packages

// 2. Spawn subprocess with pipe stdio
const child = spawn(command, [], {
  cwd: workingDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: '...',  // For claude-code-acp
    // OPENAI_API_KEY or CODEX_API_KEY for codex-acp
  },
});

// 3. Convert Node streams to Web Streams for ACP SDK
const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

// 4. Create ACP stream and connection
const stream = ndJsonStream(output, input);
const connection = new ClientSideConnection(
  (_agent) => myClientImplementation,  // Returns the Client interface impl
  stream
);

// 5. Initialize
const initResult = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
  },
});

// 6. Create session
const session = await connection.newSession({
  cwd: workingDir,
  mcpServers: [],
});
// session.sessionId is the ACP session ID (= providerSessionId in FF)

// 7. Send prompt (agent streams updates via sessionUpdate callback)
const result = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: 'text', text: userMessage }],
});
// result.stopReason indicates why the agent stopped
```

### Environment Variables per Provider

| Provider | Required Env Vars | Optional Env Vars |
|----------|------------------|-------------------|
| `claude-code-acp` | `ANTHROPIC_API_KEY` | Standard Claude Code env vars (model overrides, etc.) |
| `codex-acp` | One of: `CODEX_API_KEY`, `OPENAI_API_KEY`, or ChatGPT subscription auth | Model selection vars |

**Confidence: HIGH** -- Verified from adapter README docs and example code.

## ACP Protocol Lifecycle (Mapped to FF Session Lifecycle)

| FF Session Event | ACP Call | Notes |
|------------------|----------|-------|
| Session created | `spawn` + `initialize` + `newSession` | One subprocess per session. `newSession.sessionId` becomes FF's `providerSessionId`. |
| Session resumed | `spawn` + `initialize` + `loadSession` | Only if agent advertises `loadSession` capability in `InitializeResponse`. |
| User sends message | `prompt` | Blocks until agent completes turn. Agent streams progress via `sessionUpdate`. |
| User clicks Stop | `cancel` | Notification (no response expected). Agent should stop current turn. |
| Model changed | `setSessionConfigOption` or `unstable_setSessionModel` | Prefer `setSessionConfigOption` (stable API). |
| Mode changed | `setSessionMode` | If agent advertises modes. |
| Permission requested | Agent calls `requestPermission` | FF implements the `Client.requestPermission` callback. Returns selected option. |
| Session stopped | Kill subprocess | `child.kill('SIGTERM')` then `SIGKILL` after grace period (existing pattern). |
| Process exits | `connection.closed` resolves | Clean up session state, emit exit event. |

**Confidence: HIGH** -- Protocol lifecycle verified from official ACP docs.

## What NOT to Add (and Why)

| Rejected Approach | Why NOT | What to Do Instead |
|------------------|---------|--------------------|
| **Use `claude-code-acp` as a library** | The package exports a library API (`ClaudeAcpAgent`, `runAcp`, etc.) intended for building custom agents, not for client use. FF is a CLIENT that spawns the adapter as a subprocess. Using the library API would bypass the ACP protocol entirely and couple FF to Claude-specific internals. | Spawn `claude-code-acp` binary as subprocess, communicate via ACP protocol |
| **Use `@anthropic-ai/claude-agent-sdk` directly** | This SDK is for building agents that call Claude's API. FF doesn't call Claude directly -- it talks to the adapter subprocess via ACP. The adapter handles Claude communication internally. | Let `claude-code-acp` use the agent SDK internally; FF only speaks ACP |
| **Keep legacy protocol code behind feature flags** | Issue #996 explicitly states "pre-release breaking change, no backward compatibility needed." Flag-guarded dual protocol paths double maintenance surface and test matrix. | Remove all legacy protocol code in one clean cut |
| **Single shared ACP subprocess** | The current Codex adapter uses a shared app-server process (one process, many threads/sessions). ACP's model is one subprocess per session, matching how claude-code-acp operates. A shared process would require custom multiplexing that breaks the ACP contract. | One subprocess per FF session, matching ACP's design intent |
| **`@zed-industries/agent-client-protocol`** (deprecated) | Package was renamed to `@agentclientprotocol/sdk` as of 2025-10-10. The old package shows a deprecation warning on install. | Use `@agentclientprotocol/sdk` exclusively |
| **Build custom JSON-RPC transport** | The ACP SDK's `ndJsonStream` + `ClientSideConnection` already handles framing, serialization, request/response correlation, and type-safe callbacks. Reimplementing this is unnecessary risk. | Use `ndJsonStream` and `ClientSideConnection` from the SDK |
| **Socket-based IPC instead of stdio** | ACP specifies stdio as the transport. Both adapters expect stdin/stdout. Using Unix sockets or TCP would require forking the adapters. | stdio pipes via `spawn(..., { stdio: ['pipe', 'pipe', 'pipe'] })` |

**Confidence: HIGH** -- All rejections based on verified ACP specification and adapter documentation.

## Architecture Implications for Existing Code

### What Changes

| Current Component | What Happens | Reason |
|-------------------|-------------|--------|
| `ClaudeProcess` (claude/process.ts) | **Removed** | Replaced by generic ACP subprocess management |
| `ClaudeProtocolIO` (claude/protocol-io.ts) | **Removed** | ACP SDK handles protocol framing |
| `CodexAppServerManager` | **Removed** | No more shared app-server; each session spawns its own ACP subprocess |
| `CodexSessionRegistry` | **Removed** | No thread-to-session mapping needed; 1:1 subprocess-to-session |
| `CodexTransportEnvelope/Response/ServerRequest` schemas | **Removed** | ACP SDK provides typed schemas |
| `ClaudeRuntimeManager` | **Replaced** with ACP runtime manager | Same `ProviderRuntimeManager` interface, new implementation using `ClientSideConnection` |
| `SessionProviderAdapter` interface | **Simplified** | Several methods map directly to ACP calls; permission flow changes from boolean to option selection |
| `codex-delta-mapper.ts` / `codex-event-translator.ts` | **Replaced** with ACP event translator | `session/update` notifications replace provider-specific event formats |

### What Stays (Unchanged)

| Component | Why It Stays |
|-----------|-------------|
| `ProviderRuntimeManager` interface | Generic enough to wrap ACP connections; just the `TClient` type changes |
| `SessionProviderAdapter` interface (shape) | Operations map to ACP methods; implementation changes but interface can evolve |
| `session-store.types.ts` / `session-runtime-machine.ts` | Session state machine is provider-agnostic |
| `session-file-logger.service.ts` | File logging is orthogonal to provider protocol |
| `session-publisher.ts` | WebSocket push to frontend is unchanged |
| Bridge interfaces / orchestration layer | Cross-domain coordination is provider-agnostic |

### Process Model Change

**Before:** Claude uses one-process-per-session, Codex uses shared app-server with thread multiplexing.

**After:** Both providers use one-ACP-subprocess-per-session. This simplifies the codebase significantly -- no more thread routing, session registry mapping, or shared process state management.

**Trade-off:** More processes running simultaneously (especially for Codex which previously shared one). For typical FF usage (1-5 active sessions), this is negligible. Each ACP adapter process is lightweight.

## Installation

```bash
# Add new dependencies
pnpm add @agentclientprotocol/sdk@0.14.1

# The adapter binaries are runtime-spawned, not imported.
# Install as regular dependencies so their bins are available:
pnpm add @zed-industries/claude-code-acp@0.16.1
pnpm add @zed-industries/codex-acp@0.9.2
```

After install, verify binaries are accessible:
```bash
npx claude-code-acp --version  # Should print version
npx codex-acp --version        # Should print version
```

### Version Pinning Strategy

Pin to exact versions (no caret) for the adapter packages because:
1. Both are pre-1.0 (0.x.y) with potential breaking changes in minor versions
2. The ACP protocol itself is evolving (unstable methods exist)
3. Adapter behavior changes can affect user-facing functionality

```json
{
  "@agentclientprotocol/sdk": "0.14.1",
  "@zed-industries/claude-code-acp": "0.16.1",
  "@zed-industries/codex-acp": "0.9.2"
}
```

Update deliberately and test after each bump.

## Zod Compatibility Matrix

| Package | Zod Requirement | Project's Zod | Compatible? |
|---------|----------------|---------------|-------------|
| `@agentclientprotocol/sdk` | `^3.25.0 \|\| ^4.0.0` (peer) | `4.3.6` | YES |
| `@anthropic-ai/claude-agent-sdk` (transitive) | `^4.0.0` (peer) | `4.3.6` | YES |
| `@zed-industries/claude-code-acp` | Bundles own deps | N/A | YES (isolated) |
| `@zed-industries/codex-acp` | Native binary, no JS deps | N/A | YES |
| Factory Factory itself | `^4.3.6` | `4.3.6` | YES |

**Confidence: HIGH** -- All peer dependency ranges verified via `npm view`. No Zod conflicts.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| ACP SDK | `@agentclientprotocol/sdk` | `@zed-industries/agent-client-protocol` | Deprecated. Same code, just old package name. |
| Claude adapter | `@zed-industries/claude-code-acp` (subprocess) | Direct `@anthropic-ai/claude-agent-sdk` | FF is a client, not an agent. Using agent SDK directly bypasses ACP abstraction. |
| Codex adapter | `@zed-industries/codex-acp` (subprocess) | Keep Codex app-server protocol | Defeats the purpose of ACP-only cutover. Maintains two protocol paths. |
| Transport | `ndJsonStream` from SDK | Custom JSON-RPC implementation | SDK implementation is correct, tested, and maintained. No benefit to rolling our own. |
| Process model | One subprocess per session | Shared subprocess with multiplexing | ACP protocol assumes 1:1 process:session. Multiplexing would require custom protocol extensions. |

## Sources

- [@agentclientprotocol/sdk on npm](https://www.npmjs.com/package/@agentclientprotocol/sdk) -- v0.14.1 verified 2026-02-13
- [@zed-industries/claude-code-acp on npm](https://www.npmjs.com/package/@zed-industries/claude-code-acp) -- v0.16.1 verified 2026-02-13
- [@zed-industries/codex-acp on npm](https://www.npmjs.com/package/@zed-industries/codex-acp) -- v0.9.2 verified 2026-02-13
- [ACP TypeScript SDK GitHub](https://github.com/agentclientprotocol/typescript-sdk) -- ClientSideConnection API and examples
- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview) -- Protocol lifecycle and message types
- [ClientSideConnection API Reference](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html) -- Full method signatures
- [ACP SDK Example Client](https://github.com/agentclientprotocol/typescript-sdk/tree/main/src/examples) -- Subprocess spawn pattern
- [claude-code-acp GitHub](https://github.com/zed-industries/claude-code-acp) -- Adapter features and configuration
- [codex-acp GitHub](https://github.com/zed-industries/codex-acp) -- Adapter features, auth methods, platform binaries
- [ACP Protocol Specification](https://github.com/agentclientprotocol/agent-client-protocol) -- Schema and JSON-RPC method definitions
- [Zed ACP Announcement](https://zed.dev/acp) -- Protocol origin and ecosystem context
- Factory Factory issue #996 -- Scope definition for ACP-only cutover
