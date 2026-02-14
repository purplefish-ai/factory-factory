# Phase 19: ACP Runtime Foundation - Research

**Researched:** 2026-02-13
**Domain:** ACP subprocess lifecycle, ClientSideConnection wiring, session create/prompt/cancel with streaming
**Confidence:** HIGH

## Summary

Phase 19 builds the foundational ACP runtime that proves the entire pipeline end-to-end: spawn an ACP adapter subprocess, wire `ClientSideConnection` over stdio, complete the initialize handshake, create a provider session, send a prompt with streaming response, cancel a prompt mid-turn, and cleanly shut down. This is the first phase of the v1.2 ACP Cutover milestone and has zero dependencies on other phases.

The implementation uses `@agentclientprotocol/sdk` (v0.14.1) for the `ClientSideConnection` and `ndJsonStream` utilities, with `@zed-industries/claude-code-acp` (v0.16.1) and `@zed-industries/codex-acp` (v0.9.2) as the spawned ACP adapter binaries. The existing session domain already has well-factored abstractions (`ProviderRuntimeManager`, `SessionProviderAdapter`) that the new ACP runtime implements alongside the existing Claude/Codex runtimes. Phase 19 does NOT remove legacy code -- it adds the ACP runtime as a new implementation that can be validated independently. Legacy removal happens in Phase 22.

**Primary recommendation:** Build a new `session/acp/` subdirectory within the session domain containing `AcpRuntimeManager` (subprocess lifecycle), `AcpProcessHandle` (per-session state wrapper), and a minimal `Client` implementation that handles `sessionUpdate` and `requestPermission` callbacks. Wire streaming `session/update` notifications to `sessionDomainService.emitDelta()` for real-time chat UI rendering. Use non-detached spawn for orphan prevention. Use the `session/prompt` response (not notifications) as the authoritative turn-complete signal.

## Standard Stack

### Core (New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@agentclientprotocol/sdk` | `0.14.1` | ACP client runtime: `ClientSideConnection`, `ndJsonStream`, protocol types, JSON-RPC framing | Official ACP TypeScript SDK. Handles framing, serialization, request/response correlation, type-safe callbacks. 178 dependents. Published 2026-02-05. |
| `@zed-industries/claude-code-acp` | `0.16.1` | Claude Code ACP adapter binary (spawned as subprocess via `claude-code-acp` bin) | Production adapter used by Zed editor. Wraps `@anthropic-ai/claude-agent-sdk` internally. Published 2026-02-10. |
| `@zed-industries/codex-acp` | `0.9.2` | Codex ACP adapter binary (platform-specific native binary via `codex-acp` bin) | Production adapter used by Zed editor. Rust binary with per-platform optional deps. Published 2026-02-05. |

### Existing (No Version Changes)

| Technology | Version | Role in Phase 19 |
|------------|---------|-----------------|
| `node:child_process` | Built-in | `spawn()` for ACP adapter subprocesses |
| `node:stream` | Built-in | `Writable.toWeb()` / `Readable.toWeb()` to convert Node.js subprocess stdio to Web Streams for `ndJsonStream()` |
| `tree-kill` | `1.2.2` | Process tree termination fallback for SIGKILL escalation |
| `zod` | `4.3.6` | Already satisfies `@agentclientprotocol/sdk` peer dep (`^3.25.0 || ^4.0.0`) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@agentclientprotocol/sdk` | `@zed-industries/agent-client-protocol` | **Deprecated** (renamed 2025-10-10). Same code, old package name. Do not use. |
| `@agentclientprotocol/sdk` | Custom JSON-RPC implementation | SDK handles framing, correlation, type-safe callbacks. No benefit to hand-rolling. |
| ACP adapter subprocess | `@anthropic-ai/claude-agent-sdk` directly | FF is a CLIENT that spawns adapters, not an agent. Using agent SDK directly bypasses ACP abstraction and couples to Claude-specific internals. |
| Non-detached spawn | Detached spawn + process group kill | Non-detached children receive SIGHUP on parent death (automatic orphan cleanup). Detached processes survive parent death. Non-detached is correct for FF's use case. |

**Installation:**
```bash
pnpm add @agentclientprotocol/sdk@0.14.1 @zed-industries/claude-code-acp@0.16.1 @zed-industries/codex-acp@0.9.2
```

Pin exact versions (no caret) -- all three are pre-1.0 with potential breaking changes in minor versions.

## Architecture Patterns

### Recommended Project Structure

```
src/backend/domains/session/
├── acp/                          # NEW: ACP runtime (Phase 19)
│   ├── index.ts                  # Barrel file for ACP submodule
│   ├── types.ts                  # AcpClientOptions, AcpProcessHandle types
│   ├── acp-runtime-manager.ts    # Subprocess lifecycle (spawn, stop, track)
│   ├── acp-process-handle.ts     # Per-session state: connection, child process, session ID
│   ├── acp-client-handler.ts     # Client interface impl (sessionUpdate, requestPermission)
│   └── acp-runtime-manager.test.ts
├── claude/                       # UNCHANGED in Phase 19 (removed in Phase 22)
├── codex/                        # UNCHANGED in Phase 19 (removed in Phase 22)
├── runtime/
│   ├── provider-runtime-manager.ts  # UNCHANGED interface
│   ├── claude-runtime-manager.ts    # UNCHANGED (kept for fallback)
│   ├── codex-app-server-manager.ts  # UNCHANGED (kept for fallback)
│   └── index.ts                     # ADD AcpRuntimeManager export
├── providers/
│   └── ...                       # UNCHANGED in Phase 19
├── lifecycle/
│   └── session.service.ts        # MINIMAL changes: add ACP path alongside existing
├── chat/
│   └── chat-event-forwarder.service.ts  # MINIMAL: forward ACP events through existing pipeline
├── logging/
│   └── session-file-logger.service.ts   # UNCHANGED (already provider-agnostic)
└── ...
```

### Pattern 1: ACP Subprocess Spawn + ClientSideConnection Wiring

**What:** Spawn an ACP adapter binary as a child process with stdio pipes, convert to Web Streams, create `ndJsonStream`, instantiate `ClientSideConnection`.

**When to use:** Every time a new ACP session starts.

**Example:**
```typescript
// Source: ACP SDK example client + official docs
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Stream,
} from '@agentclientprotocol/sdk';

function createAcpConnection(
  command: string,  // 'claude-code-acp' or 'codex-acp'
  workingDir: string,
  env: Record<string, string>,
  clientFactory: (agent: unknown) => Client,
): { connection: ClientSideConnection; child: ChildProcess } {
  const child = spawn(command, [], {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    detached: false,  // CRITICAL: non-detached for orphan prevention
  });

  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const stream: Stream = ndJsonStream(output, input);

  const connection = new ClientSideConnection(
    (_agent) => clientFactory(_agent),
    stream,
  );

  return { connection, child };
}
```

### Pattern 2: Initialize + Session Create + Prompt Lifecycle

**What:** After spawning, perform the three-step handshake: `initialize` -> `newSession` -> `prompt`. The `prompt` call blocks until the agent completes the turn (or is cancelled), while `sessionUpdate` notifications stream concurrently.

**When to use:** Every session start.

**Example:**
```typescript
// Source: ACP protocol specification + SDK API docs
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// Step 1: Initialize (capability exchange)
const initResult = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    // Phase 19: minimal capabilities. Do NOT advertise fs/terminal.
    // Agents handle file operations internally via built-in MCP servers.
  },
  clientInfo: {
    name: 'factory-factory',
    title: 'Factory Factory',
    version: appVersion,
  },
});
// initResult.agentCapabilities -> store for capability gating
// initResult.protocolVersion -> verify compatibility

// Step 2: Create session
const sessionResult = await connection.newSession({
  cwd: workingDir,  // Absolute path to workspace directory
  mcpServers: [],   // No client-side MCP servers needed
});
// sessionResult.sessionId -> store as providerSessionId
// sessionResult.configOptions -> available config options (Phase 21)
// sessionResult.modes -> available modes (Phase 21)

// Step 3: Send prompt (blocks until turn completes)
// sessionUpdate notifications arrive concurrently via Client callback
const promptResult = await connection.prompt({
  sessionId: sessionResult.sessionId,
  prompt: [{ type: 'text', text: userMessage }],
});
// promptResult.stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | ...
```

### Pattern 3: Prompt Response as Authoritative Turn-Complete Signal

**What:** The `connection.prompt()` Promise resolution is the single source of truth for turn completion. Do NOT derive "idle" from `session/update` notifications alone.

**When to use:** Always, when determining if it is safe to dispatch the next queued message.

**Why critical:** ACP `session/update` notifications arrive concurrently during a prompt. If FF translates a notification into an "idle" signal and dispatches the next queued message before the prompt response resolves, overlapping prompts corrupt the conversation. This is documented as Pitfall 3 in the prior research.

**Example:**
```typescript
// In AcpRuntimeManager -- consume prompt in background
private async executePrompt(
  sessionId: string,
  handle: AcpProcessHandle,
  content: string,
): Promise<void> {
  handle.isPromptInFlight = true;

  try {
    const result = await handle.connection.prompt({
      sessionId: handle.providerSessionId,
      prompt: [{ type: 'text', text: content }],
    });

    // ONLY after prompt resolves: mark turn complete
    handle.isPromptInFlight = false;

    // Translate stop reason to FF session state
    if (result.stopReason === 'cancelled') {
      // Prompt was cancelled, session is idle but process is alive
    } else {
      // Turn completed normally
    }

    // NOW it is safe to dispatch next queued message
    await this.handlers.onTurnComplete?.(sessionId, result.stopReason);
  } catch (error) {
    handle.isPromptInFlight = false;
    await this.handlers.onError?.(sessionId, error);
  }
}
```

### Pattern 4: Non-Detached Spawn for Orphan Prevention

**What:** Spawn ACP subprocesses with `detached: false` (the default). When FF's Node.js process dies, non-detached children receive SIGHUP and exit automatically.

**Why critical:** The existing `ClaudeProcess` uses `detached: true` (line 96 of `claude/process.ts`) to create process groups for group-kill cleanup. However, detached processes survive parent death -- if FF crashes, orphaned processes continue running indefinitely. Non-detached spawn fixes this automatically: children inherit the parent's process group and receive SIGHUP when the parent exits.

**When to use:** Always for ACP subprocesses.

**Example:**
```typescript
const child = spawn(command, [], {
  cwd: workingDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...env },
  detached: false,  // Children die with parent (orphan prevention)
});
```

### Pattern 5: SIGTERM then SIGKILL Graceful Shutdown

**What:** On session stop, send SIGTERM to the child process, wait a grace period (5 seconds), then escalate to SIGKILL if still alive.

**When to use:** Every session stop.

**Example:**
```typescript
async stopClient(sessionId: string): Promise<void> {
  const handle = this.sessions.get(sessionId);
  if (!handle) return;

  this.stopping.add(sessionId);
  try {
    // First: send cancel if prompt is in flight
    if (handle.isPromptInFlight) {
      await handle.connection.cancel({ sessionId: handle.providerSessionId });
    }

    // Then: SIGTERM
    handle.child.kill('SIGTERM');

    // Wait for graceful exit with timeout
    const exitPromise = new Promise<void>((resolve) => {
      handle.child.on('exit', () => resolve());
    });
    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(resolve, 5000)
    );
    await Promise.race([exitPromise, timeoutPromise]);

    // Escalate to SIGKILL if still alive
    if (!handle.child.killed) {
      handle.child.kill('SIGKILL');
    }
  } finally {
    this.stopping.delete(sessionId);
    this.sessions.delete(sessionId);
  }
}
```

### Pattern 6: Client.sessionUpdate Callback for Streaming Events

**What:** The `Client` interface's `sessionUpdate` method receives all streaming notifications during a prompt turn. Each notification has a `sessionId` and an `update` discriminated union (keyed on `sessionUpdate` field).

**When to use:** Implement once per connection. This is the main event ingestion point.

**Example:**
```typescript
// Source: ACP SDK Client interface + protocol schema
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

class AcpClientHandler implements Client {
  constructor(
    private readonly sessionId: string,
    private readonly onEvent: (sessionId: string, update: unknown) => void,
    private readonly logger: ReturnType<typeof createLogger>,
  ) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    // Log ALL events to session file logger (EVENT-06)
    sessionFileLogger.log(this.sessionId, 'FROM_CLAUDE_CLI', {
      eventType: 'acp_session_update',
      sessionUpdate: update.sessionUpdate,
      data: update,
    });

    // Forward to session domain for WebSocket push
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onEvent(this.sessionId, {
          type: 'agent_message',
          data: {
            type: 'assistant',
            message: { role: 'assistant', content: [update.content] },
          },
        });
        break;

      case 'tool_call':
        this.onEvent(this.sessionId, {
          type: 'agent_message',
          data: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: {
                type: 'tool_use',
                id: update.toolCallId,
                name: update.title,
              },
            },
          },
        });
        break;

      case 'tool_call_update':
        this.onEvent(this.sessionId, {
          type: 'tool_progress',
          toolUseId: update.toolCallId,
          status: update.status,
        });
        break;

      // Phase 19: Log but do not render these yet
      // Phase 20 handles full event translation
      case 'agent_thought_chunk':
      case 'plan':
      case 'available_commands_update':
      case 'config_options_update':
      case 'current_mode_update':
      case 'user_message_chunk':
        this.logger.debug('ACP session update (deferred to Phase 20)', {
          sessionId: this.sessionId,
          updateType: update.sessionUpdate,
        });
        break;

      default:
        this.logger.warn('Unknown ACP session update type', {
          sessionId: this.sessionId,
          update,
        });
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    // Phase 19: Auto-approve all permissions (bypassPermissions mode)
    // Phase 20 adds full permission UI with option selection
    const allowOption = params.options.find(
      (o) => o.kind === 'allow_always' || o.kind === 'allow_once',
    );
    if (allowOption) {
      return { outcome: { selected: { optionId: allowOption.optionId } } };
    }
    // Fallback: select first option
    return { outcome: { selected: { optionId: params.options[0].optionId } } };
  }
}
```

### Anti-Patterns to Avoid

- **Using `@anthropic-ai/claude-agent-sdk` directly:** FF is a CLIENT. The agent SDK is for building agents. FF spawns adapter binaries and speaks ACP over stdio. Do not import or use the agent SDK.

- **Removing legacy code in Phase 19:** Old Claude/Codex code is the rollback path. Remove NOTHING until Phase 22 validates the ACP runtime is stable.

- **Deriving turn completion from notifications:** `session/update` notifications arrive during the prompt. Only the `prompt()` response resolves when the turn is truly complete. Dispatching the next queued message on a notification causes overlapping prompts.

- **Using `detached: true` for ACP processes:** Detached processes survive parent death. Non-detached is correct for FF.

- **Mapping ACP events to `ClaudeMessage` format:** Phase 19 should NOT try to make ACP events look exactly like Claude NDJSON messages. Forward the minimum needed for chat rendering. Full event translation is Phase 20.

- **Implementing fs/terminal client capabilities:** Agents handle file operations internally. Do NOT advertise `fs` or `terminal` capabilities in `clientCapabilities`. This is explicitly out of scope per the requirements.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON-RPC framing over stdio | Custom NDJSON parser + request correlator | `ndJsonStream` + `ClientSideConnection` from `@agentclientprotocol/sdk` | SDK handles framing, backpressure, type-safe callbacks, error handling |
| Web Stream conversion from Node streams | Custom Transform streams | `Readable.toWeb()` / `Writable.toWeb()` (Node.js built-in) | Standard library, battle-tested |
| Protocol version negotiation | Manual version check logic | `PROTOCOL_VERSION` constant from SDK + `initialize` response checking | SDK exports the current protocol version |
| Request/response correlation | Map of pending promises with manual ID tracking | `ClientSideConnection` internal correlation | SDK manages this automatically |
| Process group cleanup | `process.kill(-pid, 'SIGKILL')` with detached spawn | `child.kill('SIGTERM')` + timeout + `child.kill('SIGKILL')` on non-detached process | Non-detached spawn + SIGTERM/SIGKILL escalation is simpler and handles parent death |

**Key insight:** The ACP SDK does the heavy lifting for protocol communication. FF's job is subprocess lifecycle management and translating ACP events into FF's WebSocket delta events. Do not duplicate SDK functionality.

## Common Pitfalls

### Pitfall 1: Orphaned ACP Processes After FF Crash

**What goes wrong:** When FF crashes (SIGKILL, OOM), spawned ACP subprocesses continue running. With per-session processes, N active sessions = N orphaned processes consuming memory and holding file locks.
**Why it happens:** Current Claude process uses `detached: true` which survives parent death. ACP must NOT repeat this.
**How to avoid:** Use `detached: false` (non-detached spawn). Children receive SIGHUP on parent death and exit automatically. Additionally, record PIDs to a pidfile on disk and clean up stale processes on FF startup.
**Warning signs:** After FF restart, `ps aux | grep acp` shows processes with no FF parent.

### Pitfall 2: stdin Buffer Deadlock on Large Payloads

**What goes wrong:** Large prompts (base64 images, long system prompts) exceed OS pipe buffer (64KB). If prompt write blocks on drain while agent waits for permission response that also needs stdin, both sides deadlock.
**Why it happens:** ACP is full-duplex -- prompts and permission responses share the same stdin pipe.
**How to avoid:** For Phase 19, this is mitigated by auto-approving permissions (no permission responses need to be sent during prompt writes). For Phase 20+, implement a priority write queue that never blocks protocol responses behind prompt content.
**Warning signs:** Session stuck in "running" with no activity for > 30 seconds.

### Pitfall 3: Capability-Gating Unstable Methods

**What goes wrong:** Calling `unstable_setSessionModel` or `unstable_resumeSession` on agents that do not support them causes JSON-RPC "method not found" errors.
**Why it happens:** Hard-coded method calls without checking `agentCapabilities` during initialization.
**How to avoid:** During `initialize`, inspect `agentCapabilities` response and store a capabilities map. Before calling any unstable method, check the map. Degrade gracefully (disable UI features).
**Warning signs:** JSON-RPC "method not found" errors in session logs.

### Pitfall 4: Event Ordering Inversion (Premature Turn Completion)

**What goes wrong:** ACP `session/update` notifications arrive concurrently during prompts. If a notification triggers FF's idle handler and dispatches the next queued message before the prompt response resolves, overlapping prompts corrupt the conversation.
**Why it happens:** Mapping `session/update` to FF's `result` event without waiting for `prompt()` response.
**How to avoid:** Use `prompt()` response as the ONLY turn-complete signal. Do not derive idle from notifications.
**Warning signs:** Log entries showing "dispatching next message" before "prompt response received."

### Pitfall 5: Web Stream Conversion Gotcha

**What goes wrong:** `Readable.toWeb()` and `Writable.toWeb()` require the Node.js streams to be in flowing mode. If the child process hasn't started writing yet, or if the stream is paused, the conversion may hang.
**Why it happens:** Node.js stream state machine complexity.
**How to avoid:** Call `Readable.toWeb()` and `Writable.toWeb()` immediately after `spawn()` returns, before any data flows. The child process hasn't started yet, so the streams are in their initial state and conversion is safe.
**Warning signs:** Connection hangs during `initialize` with no errors.

### Pitfall 6: ACP Adapter Binary Not Found

**What goes wrong:** `spawn('claude-code-acp', ...)` fails with ENOENT because the binary is not in PATH.
**Why it happens:** The binaries are installed in `node_modules/.bin/` which may not be in the system PATH.
**How to avoid:** Resolve the binary path explicitly: `require.resolve('@zed-industries/claude-code-acp/bin/claude-code-acp')` or use `npx` prefix, or add `node_modules/.bin` to the spawn env's PATH.
**Warning signs:** Session start fails with "spawn ENOENT" error.

## Code Examples

### Complete ACP Session Lifecycle (Verified from SDK example + protocol docs)

```typescript
// Source: @agentclientprotocol/sdk example client + ACP protocol specification
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

// 1. Spawn subprocess
const child: ChildProcess = spawn('claude-code-acp', [], {
  cwd: '/path/to/workspace',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  detached: false,
});

// 2. Wire streams
const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

// 3. Create connection with Client implementation
const connection = new ClientSideConnection(
  (_agent) => ({
    async sessionUpdate(params: SessionNotification): Promise<void> {
      console.log('Session update:', params.update.sessionUpdate);
    },
    async requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      // Auto-approve with first allow option
      const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
      return { outcome: { selected: { optionId: allow?.optionId ?? params.options[0].optionId } } };
    },
  }),
  stream,
);

// 4. Initialize handshake
const init = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: 'factory-factory', title: 'Factory Factory', version: '1.2.0' },
});

// 5. Create session
const session = await connection.newSession({
  cwd: '/path/to/workspace',
  mcpServers: [],
});

// 6. Send prompt (streaming updates arrive via sessionUpdate callback)
const result = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: 'text', text: 'Hello, what files are in this directory?' }],
});
console.log('Stop reason:', result.stopReason);

// 7. Cancel mid-turn (send as notification)
// await connection.cancel({ sessionId: session.sessionId });

// 8. Cleanup
child.kill('SIGTERM');
```

### AcpRuntimeManager Skeleton (Following Existing ClaudeRuntimeManager Pattern)

```typescript
// Source: Existing ClaudeRuntimeManager pattern + ACP SDK
import type {
  ProviderRuntimeManager,
  RuntimeCreatedCallback,
  RuntimeEventHandlers,
} from './provider-runtime-manager';

interface AcpProcessHandle {
  connection: ClientSideConnection;
  child: ChildProcess;
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
}

interface AcpClientOptions {
  provider: 'CLAUDE' | 'CODEX';
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  workingDir: string;
}

class AcpRuntimeManager implements ProviderRuntimeManager<AcpProcessHandle, AcpClientOptions> {
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly pending = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stopping = new Set<string>();
  private onClientCreatedCallback: RuntimeCreatedCallback<AcpProcessHandle> | null = null;

  // ... implements ProviderRuntimeManager interface
  // Same dedup pattern as ClaudeRuntimeManager (pLimit, pending Map)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@zed-industries/agent-client-protocol` | `@agentclientprotocol/sdk` | 2025-10-10 (renamed) | Must use new package name exclusively |
| Binary allow/deny permissions | Multi-option selection (allow_once/always, reject_once/always) | ACP protocol design | Phase 20 handles full UI; Phase 19 auto-approves |
| Imperative config commands (`setModel`, `setThinkingBudget`) | Declarative `configOptions` from agent | ACP protocol design | Phase 21 handles full config UI |
| Claude NDJSON + Codex JSON-RPC (two protocols) | Unified ACP JSON-RPC over stdio | ACP adapters (2025+) | Both providers speak same protocol |
| Shared Codex process (multiplexed sessions) | One subprocess per session | ACP model | Simpler lifecycle, no thread routing |

**Deprecated/outdated:**
- `@zed-industries/agent-client-protocol`: Deprecated, renamed to `@agentclientprotocol/sdk`
- `detached: true` spawn for Claude: Wrong approach for orphan prevention. Use `detached: false`.
- Direct `@anthropic-ai/claude-agent-sdk` usage: FF should NOT use agent SDK directly. Speak ACP to adapter binaries.

## Open Questions

1. **Binary path resolution strategy**
   - What we know: `claude-code-acp` and `codex-acp` are installed as bins in `node_modules/.bin/`
   - What's unclear: Whether `spawn('claude-code-acp', ...)` resolves correctly in all environments (CLI, Electron, packaged app)
   - Recommendation: Test all three environments during Phase 19. If PATH issues arise, resolve binary path explicitly via `require.resolve()` or prepend `node_modules/.bin` to PATH in spawn env.

2. **Codex-acp authentication flow**
   - What we know: Codex-acp requires `CODEX_API_KEY` or `OPENAI_API_KEY` or ChatGPT browser auth. The `authenticate()` method handles this.
   - What's unclear: Whether `authenticate()` needs to be called explicitly or if env vars are sufficient.
   - Recommendation: Start with env vars only (matching current Codex config). If auth fails, investigate `authenticate()` in Phase 19. This is lower priority since Claude sessions are the primary use case.

3. **connection.closed Promise behavior**
   - What we know: `ClientSideConnection.closed` is a Promise that resolves when the connection closes.
   - What's unclear: Whether it resolves on clean subprocess exit, crash, stdin close, or all of the above.
   - Recommendation: Wire `connection.closed` alongside `child.on('exit')` and reconcile. Use whichever fires first as the authoritative exit signal.

4. **Stderr handling for ACP adapters**
   - What we know: ACP agents log to stderr (stdout is reserved for protocol). `claude-code-acp` explicitly redirects console to stderr.
   - What's unclear: Volume and structure of stderr output from adapters.
   - Recommendation: Pipe stderr to session file logger. Do not parse or interpret stderr content.

## Sources

### Primary (HIGH confidence)
- [@agentclientprotocol/sdk v0.14.1](https://www.npmjs.com/package/@agentclientprotocol/sdk) -- npm package, verified 2026-02-13
- [@zed-industries/claude-code-acp v0.16.1](https://www.npmjs.com/package/@zed-industries/claude-code-acp) -- npm package, verified 2026-02-13
- [@zed-industries/codex-acp v0.9.2](https://www.npmjs.com/package/@zed-industries/codex-acp) -- npm package, verified 2026-02-13
- [ACP TypeScript SDK GitHub](https://github.com/agentclientprotocol/typescript-sdk) -- ClientSideConnection API, ndJsonStream, example client
- [ACP Initialization Spec](https://agentclientprotocol.com/protocol/initialization.md) -- Handshake protocol, capabilities
- [ACP Session Setup Spec](https://agentclientprotocol.com/protocol/session-setup.md) -- session/new parameters and response
- [ACP Prompt Turn Spec](https://agentclientprotocol.com/protocol/prompt-turn.md) -- session/prompt, session/update, session/cancel
- [ACP Schema Spec](https://agentclientprotocol.com/protocol/schema.md) -- ContentBlock types, StopReason, SessionUpdate variants
- [ACP Transports Spec](https://agentclientprotocol.com/protocol/transports.md) -- stdio transport requirements

### Secondary (MEDIUM confidence)
- [DeepWiki: claude-code-acp architecture](https://deepwiki.com/zed-industries/claude-code-acp) -- Adapter internals, permission system, event translation
- [DeepWiki: codex-acp architecture](https://deepwiki.com/zed-industries/codex-acp) -- Rust binary, auth methods, session handling
- [claude-code-acp GitHub](https://github.com/zed-industries/claude-code-acp) -- README, features, CLI usage
- [codex-acp GitHub](https://github.com/zed-industries/codex-acp) -- README, platform binaries

### Tertiary (LOW confidence)
- Prior ACP research in `.planning/research/` -- Conducted 2026-02-13 for milestone scoping. HIGH quality but some architectural recommendations (using Claude Agent SDK directly) have been superseded by the decision to use ACP adapter binaries via `ClientSideConnection`.

### Codebase (HIGH confidence)
- `src/backend/domains/session/runtime/provider-runtime-manager.ts` -- Interface that AcpRuntimeManager must implement
- `src/backend/domains/session/runtime/claude-runtime-manager.ts` -- Reference implementation pattern (dedup, locks, stop handling)
- `src/backend/domains/session/claude/process.ts` -- Current subprocess spawn pattern (reference for what to change)
- `src/backend/domains/session/lifecycle/session.service.ts` -- Integration point for new runtime
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` -- Event forwarding pipeline
- `src/backend/domains/session/logging/session-file-logger.service.ts` -- Session log service (reuse for ACP events)
- `src/backend/domains/session/session-domain.service.ts` -- `emitDelta()` pipeline (provider-agnostic, no changes needed)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All package versions verified via npm. Peer deps confirmed compatible. Installation tested via search.
- Architecture: HIGH -- Existing codebase thoroughly analyzed. `ProviderRuntimeManager` interface is well-defined. ACP SDK API fully documented. Prior research provides validated patterns.
- Pitfalls: HIGH -- Process lifecycle pitfalls verified from existing code. Event ordering verified from protocol spec. Prior research documented 14 pitfalls with prevention strategies.

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (ACP SDK and adapters are actively developed; check for breaking changes before starting)

---

**IMPORTANT NOTE on Prior Research vs Phase 19 Scope:**

The prior milestone research (`.planning/research/`) recommended using `@anthropic-ai/claude-agent-sdk` directly (the Claude Agent SDK's `unstable_v2_createSession` API). However, the final v1.2 requirements (RUNTIME-01, RUNTIME-02) specify using ACP adapter binaries (`claude-code-acp`, `codex-acp`) with `ClientSideConnection` from `@agentclientprotocol/sdk`. This is the correct approach: FF is a CLIENT that spawns adapter subprocesses and speaks ACP over stdio. FF does NOT use the Claude Agent SDK directly. The prior research's architecture patterns (event translation, permission handling, runtime manager) are still valid -- only the integration layer changes from SDK function calls to ACP JSON-RPC.
