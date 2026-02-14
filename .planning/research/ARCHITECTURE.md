# Architecture Patterns: ACP-Only Provider Runtime

**Domain:** AI agent session management -- replacing custom Claude NDJSON + Codex app-server protocols with ACP
**Researched:** 2026-02-13
**Overall confidence:** HIGH (existing codebase thoroughly analyzed; ACP spec verified against official docs)

## Executive Summary

Factory Factory's session domain already has a well-factored provider abstraction layer (`SessionProviderAdapter`, `ProviderRuntimeManager`) that was designed to support multiple providers. The ACP cutover replaces the *internals* behind these interfaces while preserving the public API surface consumed by chat handlers, the orchestration layer, and WebSocket forwarding.

The key architectural insight: **ACP is not a third provider alongside Claude and Codex -- it is a replacement runtime that unifies both**. The Claude CLI's streaming JSON protocol and the Codex app-server's JSON-RPC protocol both get replaced by the Claude Agent SDK's subprocess management. All sessions become ACP sessions, using `@anthropic-ai/claude-agent-sdk` (which spawns Claude Code as a subprocess that speaks the SDK message protocol) rather than raw `claude` CLI process spawning or Codex app-server management.

## Recommended Architecture

### Architecture Overview

```
                    BEFORE                                    AFTER
              +------------------+                    +------------------+
              |  SessionService  |                    |  SessionService  |
              +--------+---------+                    +--------+---------+
                       |                                       |
          +------------+------------+                          |
          |                         |                 +--------+---------+
+---------+---------+  +------------+------+          | AcpSessionProvider|
|ClaudeProvider     |  |CodexProvider      |          |    Adapter        |
|  Adapter          |  |  Adapter          |          +--------+---------+
+---------+---------+  +------------+------+                   |
          |                         |                 +--------+---------+
+---------+---------+  +------------+------+          | AcpRuntimeManager|
|ClaudeRuntime      |  |CodexAppServer     |          | (1 subprocess    |
|  Manager          |  |  Manager          |          |  per session)    |
+---------+---------+  +------------+------+          +--------+---------+
          |                         |                          |
    spawn `claude`           spawn codex              @anthropic-ai/
    NDJSON stdio             app-server               claude-agent-sdk
                             JSON-RPC                  query()/session
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `AcpRuntimeManager` | Subprocess lifecycle for ACP sessions (spawn, stop, track). One subprocess per session via `@anthropic-ai/claude-agent-sdk`. Maps sessionId to SDK `Query`/`Session` handle. | `@anthropic-ai/claude-agent-sdk`, `AcpSessionProviderAdapter` |
| `AcpSessionProviderAdapter` | Implements `SessionProviderAdapter` interface. Translates ACP SDK events to canonical agent messages. Routes sendMessage/setModel/permissions through SDK. | `AcpRuntimeManager`, `SessionService`, `SessionDomainService` |
| `AcpEventTranslator` | Converts `SDKMessage` union types (`SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, etc.) to `CanonicalAgentMessageEvent` and `SessionDeltaEvent`. | `AcpSessionProviderAdapter` |
| `SessionService` (modified) | Drops dual-adapter dispatch. All sessions go through `AcpSessionProviderAdapter`. Provider resolution simplified. | `AcpSessionProviderAdapter`, `SessionDomainService`, `SessionRepository` |
| `SessionDomainService` (unchanged) | In-memory state management, transcript store, runtime state machine, publisher. **No changes needed** -- already provider-agnostic. | `SessionPublisher`, `SessionStore` |
| `ChatEventForwarderService` (modified) | Currently hardcoded to `ClaudeClient` event names. Needs to accept ACP event forwarding instead. Core forwarding logic (`forwardClaudeMessage`, `emitDelta`) stays the same. | `AcpSessionProviderAdapter`, `SessionDomainService` |

### Data Flow: Complete Request-Response Cycle

```
User types message in browser
       |
       v
[WebSocket] --> chatMessageHandlerService.handleUserInput(sessionId, text)
       |
       v
sessionService.sendSessionMessage(sessionId, content)
       |
       v
acpSessionProviderAdapter.sendMessage(sessionId, content)
       |
       v
acpRuntimeManager.getClient(sessionId) --> SDK Session handle
       |
       v
session.send(content)  // @anthropic-ai/claude-agent-sdk V2
       |
       v
[SDK spawns/manages Claude Code subprocess via stdio]
       |
       v
for await (const msg of session.stream()) {
  // SDKAssistantMessage, SDKPartialAssistantMessage,
  // SDKResultMessage, SDKSystemMessage, SDKCompactBoundaryMessage
}
       |
       v
acpEventTranslator.translate(sdkMessage)
       |  --> CanonicalAgentMessageEvent / SessionDeltaEvent
       v
sessionDomainService.appendClaudeEvent(sessionId, translated)
       |  --> assigns order number
       v
sessionDomainService.emitDelta(sessionId, deltaEvent)
       |
       v
sessionPublisher --> chatConnectionService.forwardToSession(sessionId, wsMessage)
       |
       v
[WebSocket] --> Browser renders message
```

### ACP SDK Event to FF State Mapping

| SDK Event Type | `SDKMessage.type` | Maps To (SessionDeltaEvent) | Maps To (SessionRuntimeState) |
|---|---|---|---|
| `SDKAssistantMessage` | `"assistant"` | `agent_message` (kind: assistant_text) | phase: running, activity: WORKING |
| `SDKPartialAssistantMessage` | `"stream_event"` | `agent_message` (kind: provider_event) | (no change) |
| `SDKUserMessage` | `"user"` | `agent_message` (kind: tool_result if has tool_result content) | (no change) |
| `SDKResultMessage` | `"result"` | `agent_message` (kind: completion) | phase: idle, activity: IDLE |
| `SDKSystemMessage` (init) | `"system"` subtype `"init"` | `system_init` | phase: idle, processState: alive |
| `SDKCompactBoundaryMessage` | `"system"` subtype `"compact_boundary"` | `compact_boundary` | (no change) |
| Tool use (from assistant content) | content_block with `type: "tool_use"` | `agent_message` (stream_event wrapper) | (no change) |
| Interactive request (AskUserQuestion/ExitPlanMode) | Hook: `PermissionRequest` or `canUseTool` callback | `permission_request` or `user_question` | (no change -- waiting for user) |
| Process exit | SDK async generator completes / session.close() | runtime exit handling | phase: idle, processState: stopped |

### Interactive Request Flow (Permissions/Questions)

ACP changes how interactive requests work. The Claude CLI custom protocol used `ControlRequest` messages over the NDJSON protocol. The SDK uses the `canUseTool` callback or `PermissionRequest` hooks:

```
Claude Code subprocess needs permission
       |
       v
SDK canUseTool callback fires: (toolName, input, { signal })
       |
       v
acpSessionProviderAdapter.handlePermissionCallback(sessionId, toolName, input)
       |
       v
sessionDomainService.setPendingInteractiveRequest(sessionId, request)
sessionDomainService.emitDelta(sessionId, { type: 'permission_request', ... })
       |
       v
[WebSocket] --> Browser shows approval UI
       |
       v
User clicks Allow/Deny
       |
       v
chatMessageHandlerService.handlePermissionResponse(sessionId, requestId, allow)
       |
       v
acpSessionProviderAdapter.respondToPermission(sessionId, requestId, allow)
       |
       v
Stored Promise resolves with { behavior: 'allow', updatedInput } or { behavior: 'deny', message }
       |
       v
Claude Code subprocess continues/stops tool execution
```

For `AskUserQuestion`, the tool is invoked through the same `canUseTool` path but with `toolName === 'AskUserQuestion'`. The adapter extracts questions from the input, stores a pending request, and emits a `user_question` delta. When the user answers, the stored Promise resolves with `{ behavior: 'allow', updatedInput: { ...input, answers } }`.

## Patterns to Follow

### Pattern 1: One Subprocess Per Session (replacing shared Codex app-server)

**What:** Each FF session gets its own `@anthropic-ai/claude-agent-sdk` subprocess. The Codex model used a shared app-server process with thread multiplexing. ACP eliminates this.

**Why:** The Claude Agent SDK V2's `createSession()` spawns a dedicated Claude Code process. Sessions are isolated. No thread routing, no session registry mapping, no shared process failure cascade.

**Implementation:**
```typescript
// session/acp/acp-runtime-manager.ts
class AcpRuntimeManager implements ProviderRuntimeManager<AcpSessionHandle, AcpClientOptions> {
  private readonly sessions = new Map<string, AcpSessionHandle>();
  private readonly pending = new Map<string, Promise<AcpSessionHandle>>();
  private readonly stopping = new Set<string>();
  private onClientCreatedCallback: RuntimeCreatedCallback<AcpSessionHandle> | null = null;

  async getOrCreateClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: RuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<AcpSessionHandle> {
    // Dedup concurrent creation attempts (same pattern as ClaudeRuntimeManager)
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const existingPending = this.pending.get(sessionId);
    if (existingPending) return await existingPending;

    const createPromise = this.createSession(sessionId, options, handlers, context);
    this.pending.set(sessionId, createPromise);
    try {
      const handle = await createPromise;
      this.sessions.set(sessionId, handle);
      this.onClientCreatedCallback?.(sessionId, handle, context);
      return handle;
    } finally {
      this.pending.delete(sessionId);
    }
  }

  private async createSession(
    sessionId: string,
    options: AcpClientOptions,
    handlers: RuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<AcpSessionHandle> {
    const sdkOptions = {
      model: options.model,
      cwd: options.workingDir,
      systemPrompt: options.systemPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: options.systemPrompt }
        : { type: 'preset' as const, preset: 'claude_code' as const },
      permissionMode: options.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions: options.permissionMode === 'bypassPermissions',
      mcpServers: options.mcpServers,
      canUseTool: this.buildCanUseToolCallback(sessionId),
      settingSources: ['project' as const],
    };

    const session = options.resumeSessionId
      ? unstable_v2_resumeSession(options.resumeSessionId, sdkOptions)
      : unstable_v2_createSession(sdkOptions);

    // Start consuming the event stream in background
    this.consumeEventStream(sessionId, session, handlers);

    return {
      session,
      sessionId,
      sdkSessionId: null, // populated from first message
      isWorking: false,
    };
  }
}
```

### Pattern 2: Event Translation Layer (same pattern as CodexEventTranslator)

**What:** A dedicated translator converts SDK message types to Factory Factory's canonical event format. This follows the same pattern used for the Codex adapter's `CodexEventTranslator`.

**Why:** Keeps the translation logic isolated and testable. The `CanonicalAgentMessageEvent` and `SessionDeltaEvent` types are the session domain's internal contract -- they must not change for a runtime swap.

```typescript
// session/acp/acp-event-translator.ts
class AcpEventTranslator {
  translateMessage(msg: SDKMessage): SessionDeltaEvent[] {
    switch (msg.type) {
      case 'assistant':
        return this.translateAssistant(msg);
      case 'result':
        return this.translateResult(msg);
      case 'system':
        return this.translateSystem(msg);
      case 'stream_event':
        return this.translateStreamEvent(msg);
      case 'user':
        return this.translateUser(msg);
      default:
        return [];
    }
  }

  private translateAssistant(msg: SDKAssistantMessage): SessionDeltaEvent[] {
    const events: SessionDeltaEvent[] = [];

    // Extract tool_use content blocks as stream_event wrappers (same as current behavior)
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const [index, item] of content.entries()) {
        if (item.type === 'tool_use') {
          events.push({
            type: 'agent_message',
            data: {
              type: 'stream_event',
              event: { type: 'content_block_start', index, content_block: item },
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    }

    // Forward narrative text as agent_message
    events.push({
      type: 'agent_message',
      data: {
        type: 'assistant',
        session_id: msg.session_id,
        uuid: msg.uuid,
        message: msg.message,
      },
    });

    return events;
  }

  private translateResult(msg: SDKResultMessage): SessionDeltaEvent[] {
    return [{
      type: 'agent_message',
      data: {
        type: 'result',
        session_id: msg.session_id,
        uuid: msg.uuid,
        result: msg.subtype === 'success' ? msg.result : undefined,
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        total_cost_usd: msg.total_cost_usd,
      },
    }];
  }

  private translateSystem(msg: SDKSystemMessage | SDKCompactBoundaryMessage): SessionDeltaEvent[] {
    if (msg.subtype === 'init') {
      const initMsg = msg as SDKSystemMessage;
      return [{
        type: 'system_init',
        data: {
          tools: initMsg.tools,
          model: initMsg.model,
          cwd: initMsg.cwd,
          apiKeySource: initMsg.apiKeySource,
        },
      }];
    }
    if (msg.subtype === 'compact_boundary') {
      return [{ type: 'compact_boundary' }];
    }
    return [];
  }
}
```

### Pattern 3: Promise-Based Permission Handling (replacing ControlRequest protocol)

**What:** The SDK's `canUseTool` callback replaces the custom `ControlRequest`/`ControlResponse` NDJSON protocol. FF stores a deferred Promise per pending permission request, resolving it when the user responds via WebSocket.

**Why:** The SDK handles the permission lifecycle internally. FF provides the decision via a Promise that resolves when the user responds. This is fundamentally simpler than the current ControlRequest/ControlResponse message exchange.

```typescript
// session/acp/acp-permission-handler.ts
interface PendingDecision {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  requestId: string;
}

class AcpPermissionHandler {
  private readonly pendingDecisions = new Map<string, PendingDecision>();

  buildCanUseToolCallback(sessionId: string): CanUseTool {
    return async (toolName, input, { signal }) => {
      // In bypassPermissions mode, auto-approve everything
      if (this.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      const requestId = crypto.randomUUID();

      // Handle AskUserQuestion specially -- it always needs user interaction
      if (toolName === 'AskUserQuestion') {
        return this.handleAskUserQuestion(sessionId, requestId, input, signal);
      }

      // Handle ExitPlanMode -- needs plan approval
      if (toolName === 'ExitPlanMode') {
        return this.handleExitPlanMode(sessionId, requestId, input, signal);
      }

      // Default: auto-approve in bypassPermissions mode
      return { behavior: 'allow', updatedInput: input };
    };
  }

  respondToPermission(requestId: string, allow: boolean): void {
    const pending = this.pendingDecisions.get(requestId);
    if (!pending) return;
    this.pendingDecisions.delete(requestId);

    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: {} });
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied' });
    }
  }

  respondToQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingDecisions.get(requestId);
    if (!pending) return;
    this.pendingDecisions.delete(requestId);

    // Resolve with answers embedded in updatedInput
    pending.resolve({
      behavior: 'allow',
      updatedInput: { answers },
    });
  }
}
```

### Pattern 4: Session Resume via SDK session ID

**What:** The existing `claudeSessionId` stored in the database maps directly to the SDK's session ID concept. Session resume uses `unstable_v2_resumeSession(sessionId)`.

**Why:** The Claude Agent SDK manages its own session persistence in `~/.claude/projects/`. FF stores the mapping (FF session ID -> Claude session ID) in the database. Resume is a first-class SDK operation.

```typescript
// In AcpRuntimeManager.createSession()
if (options.resumeSessionId) {
  const session = unstable_v2_resumeSession(options.resumeSessionId, {
    model: options.model,
    cwd: options.workingDir,
    systemPrompt: options.systemPrompt
      ? { type: 'preset', preset: 'claude_code', append: options.systemPrompt }
      : undefined,
    permissionMode: options.permissionMode,
    // ... same options as create
  });
  return { session, sessionId, sdkSessionId: options.resumeSessionId, isWorking: false };
}
```

### Pattern 5: Background Event Stream Consumption

**What:** The SDK V2's `session.stream()` returns an async generator. FF needs to consume this in a background task (not blocking the request that called `send()`), translating each event and forwarding it through the existing `sessionDomainService.emitDelta()` pipeline.

**Why:** The current `ClaudeClient` uses EventEmitter pattern -- events fire asynchronously. The SDK V2 uses async iteration instead. FF needs to bridge this gap by consuming the stream in a detached async task.

```typescript
// In AcpRuntimeManager
private consumeEventStream(
  sessionId: string,
  session: Session,
  handlers: RuntimeEventHandlers
): void {
  const consume = async () => {
    try {
      for await (const msg of session.stream()) {
        // Extract session ID from first message
        if (msg.session_id && !this.sessions.get(sessionId)?.sdkSessionId) {
          const handle = this.sessions.get(sessionId);
          if (handle) handle.sdkSessionId = msg.session_id;
          await handlers.onSessionId?.(sessionId, msg.session_id);
        }

        // Translate and forward events
        const events = this.eventTranslator.translateMessage(msg);
        for (const event of events) {
          const order = sessionDomainService.appendClaudeEvent(sessionId, event.data);
          sessionDomainService.emitDelta(sessionId, { ...event, order });
        }

        // Update working state
        if (msg.type === 'result') {
          const handle = this.sessions.get(sessionId);
          if (handle) handle.isWorking = false;
        } else if (msg.type === 'assistant') {
          const handle = this.sessions.get(sessionId);
          if (handle) handle.isWorking = true;
        }
      }
    } catch (error) {
      await handlers.onError?.(sessionId, error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Stream completed = process exited
      this.sessions.delete(sessionId);
      await handlers.onExit?.(sessionId, 0);
    }
  };

  // Fire and forget -- do not await
  consume().catch((error) => {
    logger.error('Event stream consumption failed', { sessionId, error });
  });
}
```

## What Gets Removed vs Modified

### Removed Entirely

| Module/File | Reason |
|---|---|
| `session/claude/process.ts` | Raw `claude` CLI subprocess spawning replaced by SDK |
| `session/claude/protocol.ts` | Custom NDJSON streaming protocol replaced by SDK |
| `session/claude/protocol-io.ts` | Protocol IO adapter no longer needed |
| `session/claude/permissions.ts` | Permission handlers replaced by SDK `canUseTool` |
| `session/claude/permission-coordinator.ts` | Coordination logic moves into ACP permission handler |
| `session/claude/monitoring.ts` | Process monitoring replaced by SDK lifecycle |
| `session/claude/registry.ts` | Process registry replaced by AcpRuntimeManager's session map |
| `session/claude/client.ts` | `ClaudeClient` class replaced by SDK Session handle |
| `session/claude/session.ts` (`SessionManager`) | History reading replaced by SDK session load/resume |
| `session/runtime/claude-runtime-manager.ts` | Replaced by `AcpRuntimeManager` |
| `session/runtime/codex-app-server-manager.ts` | Eliminated -- no more shared app-server |
| `session/providers/claude-session-provider-adapter.ts` | Replaced by `AcpSessionProviderAdapter` |
| `session/providers/codex-session-provider-adapter.ts` | Eliminated -- unified under ACP |
| `session/codex/*` (entire directory) | All Codex protocol code eliminated |

### Modified

| Module/File | What Changes |
|---|---|
| `session/index.ts` | Barrel exports change: remove Claude/Codex-specific types, export ACP types |
| `session/providers/index.ts` | Export `AcpSessionProviderAdapter` instead of Claude/Codex adapters |
| `session/providers/session-provider-adapter.ts` | `SessionProvider` type: add `'ACP'`, eventually remove `'CLAUDE'` / `'CODEX'` |
| `session/runtime/index.ts` | Export `AcpRuntimeManager` instead of Claude/Codex managers |
| `session/runtime/provider-runtime-manager.ts` | Interface stays the same (already generic). May simplify `TClient` to `AcpSessionHandle`. |
| `session/lifecycle/session.service.ts` | Major simplification: remove dual-adapter dispatch, `resolveAdapterForProvider()`, Codex event translator, provider caching, `createCodexClient()`. Single adapter path. |
| `session/lifecycle/session.prompt-builder.ts` | Minimal change -- system prompt construction is provider-agnostic already |
| `session/chat/chat-event-forwarder.service.ts` | Rewrite event setup to consume ACP event stream instead of `ClaudeClient` EventEmitter. Core forwarding logic (`forwardClaudeMessage`, `emitDelta`) stays. |
| `session/chat/chat-message-handlers/` | Update handlers that reference `ClaudeClient` directly to use ACP adapter |
| `session/data/session-provider-resolver.service.ts` | Simplify or remove provider resolution (everything is ACP) |
| `session/bridges.ts` | No changes (workspace bridge is provider-agnostic) |
| `session/session-domain.service.ts` | No changes (already provider-agnostic) |
| `session/store/*` | No changes (store layer is provider-agnostic) |
| `session/logging/session-file-logger.service.ts` | No changes (logging is provider-agnostic) |
| `prisma/schema.prisma` | `SessionProvider` enum: add `ACP` value, eventually deprecate `CLAUDE`/`CODEX` |
| `shared/claude/protocol/websocket.ts` | Add new delta event types for ACP-native data (cost, usage, structured output) |

### New Modules

| Module/File | Purpose |
|---|---|
| `session/acp/acp-runtime-manager.ts` | Manages SDK session lifecycle (create, resume, stop, track). Implements `ProviderRuntimeManager`. |
| `session/acp/acp-event-translator.ts` | Translates `SDKMessage` types to `SessionDeltaEvent`. Testable in isolation. |
| `session/acp/acp-session-handle.ts` | Type definitions for the SDK session wrapper (session reference, working state, session ID). |
| `session/acp/acp-permission-handler.ts` | Manages `canUseTool` promise lifecycle -- stores pending decisions, resolves when user responds via WebSocket. |
| `session/acp/types.ts` | ACP-specific type definitions, option interfaces. |
| `session/acp/index.ts` | Barrel file for ACP submodule. |
| `session/providers/acp-session-provider-adapter.ts` | Implements `SessionProviderAdapter` for ACP. |

## Anti-Patterns to Avoid

### Anti-Pattern 1: Keeping Claude/Codex Adapters "Just in Case"

**What:** Keeping the old provider adapters alongside ACP, routing by provider type at runtime.
**Why bad:** Three code paths instead of one. Every session feature needs three implementations. Bug surface area triples. The whole point of ACP is unification.
**Instead:** Remove Claude and Codex adapters. If rollback is needed, it exists in git history.

### Anti-Pattern 2: Mapping SDK Events to `ClaudeMessage` Internal Format

**What:** Making ACP events look exactly like `ClaudeMessage` (the existing NDJSON format) to minimize downstream changes.
**Why bad:** Creates a lossy translation layer. SDK messages have richer data (`total_cost_usd`, `modelUsage`, `structured_output`, `permission_denials`) that `ClaudeMessage` cannot represent. The frontend WebSocket contract should extend to surface this data.
**Instead:** Define a translation that preserves the existing `SessionDeltaEvent` structure (for backward compatibility with the frontend) but extends it with new optional fields for ACP-native data.

### Anti-Pattern 3: Global Singleton ACP Manager (like Codex app-server)

**What:** Creating a single `AcpManager` that multiplexes sessions like `CodexAppServerManager` did.
**Why bad:** The SDK already handles process lifecycle per-session. Adding session routing on top recreates the complexity that made Codex's shared process fragile (the thread-to-session registry, the shared pending request map, the cascade failures).
**Instead:** `AcpRuntimeManager` is a `Map<sessionId, AcpSessionHandle>`. Each session owns its subprocess.

### Anti-Pattern 4: Forking SDK V1 vs V2 Code Paths

**What:** Supporting both V1 `query()` and V2 `createSession()` APIs.
**Why bad:** V2 is specifically designed for multi-turn conversations with `send()`/`stream()` separation. V1's async generator model requires coordinating input/output through a single iterator, which is harder to integrate with FF's message queue pattern.
**Instead:** Use V2 exclusively (`unstable_v2_createSession` / `unstable_v2_resumeSession`). Accept the "unstable" prefix -- the API surface is small and well-defined. Pin the SDK version. The V2 API maps naturally to FF's request-response flow: `send()` = dispatch user message, `stream()` = consume events.

### Anti-Pattern 5: Rewriting ChatEventForwarderService from Scratch

**What:** Replacing the entire event forwarder because it references `ClaudeClient`.
**Why bad:** The forwarder's core value is in its event-to-delta mapping logic (tool use tracking, message normalization, interactive request routing, workspace notifications). Most of this is provider-agnostic.
**Instead:** Extract the ClaudeClient-specific event listener setup into a replaceable setup method. Keep the forwarding/routing logic intact. The new ACP adapter calls the same forwarding methods but wires them to SDK events instead of ClaudeClient events.

## Resource Management: One Subprocess Per Session

### Process Count Impact

Currently: Claude sessions each get a subprocess. Codex sessions share one app-server process.
After: Every session gets its own subprocess (via the SDK).

**Implications:**
- Worst case: N active sessions = N Claude Code subprocesses
- Each subprocess: ~100-200MB RSS (Node.js + Claude Code runtime)
- FF already handles this for Claude sessions. Codex sessions moving to per-session processes is the only delta.
- In practice, most workspaces have 1-3 active sessions. The load is manageable.

### Lifecycle Changes

| Concern | Before | After |
|---------|--------|-------|
| Process creation | `ClaudeProcess.spawn()` / `CodexAppServerManager.ensureStarted()` | `unstable_v2_createSession()` / `unstable_v2_resumeSession()` |
| Process cleanup | `client.stop()` / `process.kill(-pid, SIGKILL)` | `session.close()` (SDK handles subprocess cleanup) |
| Orphan detection | PID tracking in DB, `processRegistry` global Map | SDK manages subprocess lifecycle; `AcpRuntimeManager.sessions` Map tracks active handles |
| Idle timeout | `ClaudeProcessMonitor` with hung detection | SDK handles timeouts internally; FF can track idle via `SDKResultMessage` events |
| Graceful shutdown | `stopAllClients()` iterates Map, kills processes with timeout | Same pattern: iterate sessions Map, call `session.close()` with timeout + force kill fallback |

### Session State Machine (unchanged)

The `SessionRuntimeMachine` continues to drive the same state transitions:

```
loading -> starting -> running <-> idle -> stopping -> (back to idle/stopped)
                  \-> error
```

The transitions are triggered by ACP events instead of `ClaudeClient` events, but the states and the WebSocket `session_runtime_updated` messages remain identical. **The frontend does not need to know about the runtime swap for basic functionality.**

## Scalability Considerations

| Concern | At 5 sessions | At 50 sessions | At 200 sessions |
|---------|---------------|----------------|-----------------|
| Memory | ~1GB total (5 subprocesses) | ~10GB (needs tuning) | Likely needs subprocess pooling or idle eviction |
| Process creation | Instant | SDK spawns are sequential per session; no bottleneck | May need spawn rate limiting |
| Port conflicts | N/A (stdio, not network) | N/A | N/A |
| Shutdown time | <5s | ~10s with parallel close | Need timeout + force kill fallback |

## Suggested Build Order

Based on dependency analysis, build in this order:

### Phase 1: ACP Foundation (no production changes yet)

1. **`session/acp/types.ts`** -- Define `AcpClientOptions`, `AcpSessionHandle` types
2. **`session/acp/acp-event-translator.ts`** -- Translate SDK messages to `SessionDeltaEvent`. Can be built and tested in complete isolation against SDK type definitions.
3. **`session/acp/acp-permission-handler.ts`** -- Promise-based permission lifecycle. Testable without subprocess.
4. **`session/acp/acp-runtime-manager.ts`** -- Implements `ProviderRuntimeManager`. Wraps SDK `createSession`/`resumeSession`. Includes background event stream consumption.
5. **`session/providers/acp-session-provider-adapter.ts`** -- Implements `SessionProviderAdapter`. Wires runtime manager + event translator + permission handler.
6. **`session/acp/index.ts`** -- Barrel file

### Phase 2: Integration (wiring into session domain)

7. **Modify `session/lifecycle/session.service.ts`** -- Replace dual-adapter dispatch with single ACP adapter. Can keep old code behind feature flag initially if needed.
8. **Modify `session/chat/chat-event-forwarder.service.ts`** -- Swap ClaudeClient event listener setup for ACP event consumption pattern. Keep existing forwarding logic.
9. **Modify `session/chat/chat-message-handlers/`** -- Update handlers that reference ClaudeClient directly.
10. **Prisma migration** -- Add `ACP` to `SessionProvider` enum. Create migration to backfill existing sessions.
11. **Update `session/index.ts`** -- Adjust barrel exports for new ACP types.

### Phase 3: Removal

12. **Delete `session/claude/` directory** (process.ts, protocol.ts, protocol-io.ts, client.ts, permissions.ts, permission-coordinator.ts, monitoring.ts, registry.ts, session.ts, constants.ts, types.ts)
13. **Delete `session/codex/` directory** (entire Codex protocol stack)
14. **Delete `session/runtime/claude-runtime-manager.ts`** and `session/runtime/codex-app-server-manager.ts`
15. **Delete `session/providers/claude-session-provider-adapter.ts`** and `session/providers/codex-session-provider-adapter.ts`
16. **Update `session/index.ts`** barrel exports (remove all deleted type exports)
17. **Update `.dependency-cruiser.cjs`** if rules reference removed paths
18. **Clean up `SessionProvider` enum** in Prisma -- eventually remove `CLAUDE`/`CODEX` values

### Phase 4: Frontend Alignment

19. **Update `src/shared/claude/protocol/websocket.ts`** -- Add ACP-specific delta event types (cost reporting, structured output)
20. **Update frontend session hooks** -- Handle new event types if any
21. **Remove provider selection UI** -- No longer needed when everything is ACP

**Phase ordering rationale:**
- Phase 1 items have no dependencies on each other and can be built in parallel
- Phase 2 depends on Phase 1 being complete (need the adapter to wire in)
- Phase 3 cannot happen until Phase 2 is proven stable (old code is the fallback)
- Phase 4 is optional enhancement -- the frontend works without it since the base `SessionDeltaEvent` types are preserved

## Open Questions for Phase-Specific Research

1. **SDK V2 stability:** The V2 API is marked `unstable_v2_*`. What is Anthropic's stability timeline? Mitigation: pin SDK version, wrap in thin adapter layer.
2. **`canUseTool` vs `PermissionRequest` hook:** The SDK offers both `canUseTool` (synchronous per-tool callback returning a Promise) and `PermissionRequest` hooks (async hooks with decision/reason). Which gives better control over FF's permission flow? The `canUseTool` approach seems more natural for FF since it returns a `PermissionResult` directly. Needs experimentation.
3. **SDK subprocess cleanup:** Does the SDK reliably clean up subprocesses on `session.close()`? Need to verify orphan behavior under crash scenarios (FF server killed, SDK process hangs). May need PID tracking fallback.
4. **Transcript hydration:** The SDK's `resumeSession()` replays history through the stream. Does this provide enough data for FF's transcript hydration in `SessionHydrator`, or does FF still need to read Claude's JSONL files from `~/.claude/projects/`?
5. **Partial messages / streaming:** The SDK supports `includePartialMessages` option. Currently disabled in FF. Should this be enabled for the ACP migration to provide real-time streaming?
6. **Cost and usage tracking:** `SDKResultMessage` includes `total_cost_usd`, `modelUsage`, `usage`. FF doesn't currently surface this. This is an opportunity to add cost visibility but is not a migration blocker.
7. **Event stream backpressure:** The SDK V2 `session.stream()` async generator could buffer if FF's event processing is slow. Need to verify that the background consumption loop handles backpressure correctly.

## Sources

- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview) -- Agent Client Protocol specification
- [ACP Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn) -- Session/update event model
- [ACP Tool Calls](https://agentclientprotocol.com/protocol/tool-calls) -- Permission and tool execution protocol
- [ACP Transport](https://agentclientprotocol.com/protocol/transports) -- Stdio transport specification
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) -- Official ACP TypeScript SDK
- [Claude Agent SDK TypeScript V1 Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- Complete V1 API reference with all types
- [Claude Agent SDK TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- V2 session-based API
- [Claude Code ACP Issue #6686](https://github.com/anthropics/claude-code/issues/6686) -- ACP support discussion and community implementations
- [ACP Schema](https://agentclientprotocol.com/protocol/schema) -- Content block and session update type definitions
- [ACP Session Setup](https://agentclientprotocol.com/protocol/session-setup) -- Session creation and capabilities
- Factory Factory codebase analysis: `src/backend/domains/session/` (providers/, runtime/, claude/, codex/, chat/, lifecycle/, store/, bridges.ts, index.ts, session-domain.service.ts)
- Factory Factory shared types: `src/shared/session-runtime.ts`, `src/shared/claude/protocol/websocket.ts`

---

**Note on terminology:** This document uses "ACP" broadly to mean "the unified runtime that replaces both custom protocols." The actual implementation uses `@anthropic-ai/claude-agent-sdk` which spawns Claude Code as a subprocess. The ACP standard itself (`@agentclientprotocol/sdk`) is a separate protocol spec used by editors like Zed for editor-agent interop. For FF's purposes, the Claude Agent SDK is the right integration point -- it provides the subprocess management, event streaming, hooks, and session lifecycle that FF needs. FF is an embedder (programmatic control of Claude Code), not an editor (user-facing code editing), so the Agent SDK is the correct abstraction layer.
