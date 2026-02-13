# Phase 20: Event Translation + Permissions - Research

**Researched:** 2026-02-13
**Domain:** ACP SDK event translation, FF delta pipeline, permission UI
**Confidence:** HIGH

## Summary

Phase 20 takes the minimal ACP event handling from Phase 19 and builds full event translation for all ACP session update types (tool calls with lifecycle, thoughts, plans, slash commands) plus replaces the auto-approve permission stub with an end-to-end multi-option permission flow. The ACP SDK (`@agentclientprotocol/sdk@0.14.1`) provides well-typed discriminated unions for all session update variants and a clear `RequestPermissionRequest` / `RequestPermissionResponse` contract with multi-option support (allow_once, allow_always, reject_once, reject_always).

The existing FF delta pipeline is mature and well-documented. ACP events need to be translated into the existing `SessionDeltaEvent` types (primarily `agent_message`, `tool_progress`, `permission_request`, `slash_commands`) that the frontend already knows how to render. The key gap is that Phase 19 only forwards `agent_message_chunk`, `tool_call`, and `tool_call_update` (with minimal mapping), while `agent_thought_chunk`, `plan`, `available_commands_update`, and `config_option_update` are logged but not translated. Permissions are auto-approved.

**Primary recommendation:** Build an `AcpEventTranslator` class (modeled on the existing `CodexEventTranslator`) that maps all ACP SessionUpdate variants to FF SessionDeltaEvent types. For permissions, change `AcpClientHandler.requestPermission()` from auto-approve to a Promise-based bridge that suspends until the frontend user responds via WebSocket.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @agentclientprotocol/sdk | 0.14.1 | ACP types and connection | Already installed, provides all session update and permission types |
| React | existing | Frontend rendering | Current frontend framework |
| Zod | existing | Schema validation | Used throughout for WS message validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | existing | Icons for permission buttons | UI treatment for allow/deny options |
| shadcn/ui | existing | Button, Card components | Permission option buttons |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| AcpEventTranslator class | Inline switch in setupAcpEventHandler | Class matches CodexEventTranslator pattern, testable in isolation |
| Promise-based permission bridge | EventEmitter bridge | Promise naturally maps to the async requestPermission() return type |

## Architecture Patterns

### Recommended Project Structure
```
src/backend/domains/session/acp/
  acp-client-handler.ts       # MODIFY: full event translation, async permission bridge
  acp-event-translator.ts     # NEW: maps ACP SessionUpdate -> FF SessionDeltaEvent
  acp-event-translator.test.ts # NEW: unit tests
  acp-permission-bridge.ts    # NEW: manages pending permission Promises
  acp-permission-bridge.test.ts # NEW: unit tests
  acp-runtime-manager.ts      # UNCHANGED
  acp-process-handle.ts       # UNCHANGED
  types.ts                    # MODIFY: add ACP permission/event types

src/shared/claude/protocol/
  interaction.ts              # MODIFY: extend PermissionRequest with ACP option fields
  websocket.ts                # MODIFY: extend permission_request payload with options

src/shared/websocket/
  chat-message.schema.ts      # MODIFY: extend permission_response with optionId

src/backend/domains/session/chat/chat-message-handlers/handlers/
  permission-response.handler.ts # MODIFY: handle optionId for ACP sessions

src/components/chat/
  permission-prompt.tsx        # MODIFY: render multi-option buttons for ACP permissions
  reducer/slices/requests.ts   # MODIFY: handle ACP permission options in state

src/backend/domains/session/lifecycle/
  session.service.ts           # MODIFY: wire ACP permission bridge, update setupAcpEventHandler
```

### Pattern 1: AcpEventTranslator (mirrors CodexEventTranslator)
**What:** A stateless class that maps ACP `SessionUpdate` variants to `SessionDeltaEvent[]`
**When to use:** For every ACP session update notification
**Example:**
```typescript
// Source: existing pattern from src/backend/domains/session/codex/codex-event-translator.ts
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { SessionDeltaEvent } from '@/shared/claude';

export class AcpEventTranslator {
  translateSessionUpdate(update: SessionUpdate): SessionDeltaEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.translateAgentMessageChunk(update);
      case 'agent_thought_chunk':
        return this.translateAgentThoughtChunk(update);
      case 'tool_call':
        return this.translateToolCall(update);
      case 'tool_call_update':
        return this.translateToolCallUpdate(update);
      case 'plan':
        return this.translatePlan(update);
      case 'available_commands_update':
        return this.translateAvailableCommands(update);
      // ... etc
    }
  }
}
```

### Pattern 2: Promise-Based Permission Bridge
**What:** A bridge that stores pending Promises keyed by a unique request ID, resolved when the user responds via WebSocket
**When to use:** For ACP `requestPermission()` which must return a `RequestPermissionResponse`
**Example:**
```typescript
// The AcpClientHandler.requestPermission() suspends on a Promise
// The WebSocket permission_response handler resolves it

export class AcpPermissionBridge {
  private pending = new Map<string, {
    resolve: (response: RequestPermissionResponse) => void;
    options: PermissionOption[];
    toolCall: ToolCallUpdate;
  }>();

  // Called by AcpClientHandler.requestPermission()
  waitForUserResponse(
    requestId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        resolve,
        options: params.options,
        toolCall: params.toolCall,
      });
    });
  }

  // Called by permission-response.handler.ts for ACP sessions
  resolvePermission(requestId: string, optionId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve({
      outcome: { outcome: 'selected', optionId },
    });
    this.pending.delete(requestId);
    return true;
  }

  // Called when session is cancelled/stopped
  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      entry.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pending.clear();
  }
}
```

### Pattern 3: Extended Permission Request for Frontend
**What:** Augment the existing `permission_request` WebSocket message with ACP option data
**When to use:** When the backend emits a permission_request delta event from ACP
**Example:**
```typescript
// Backend emits:
sessionDomainService.emitDelta(sid, {
  type: 'permission_request',
  requestId: bridgeRequestId,
  toolName: params.toolCall.title,
  toolUseId: params.toolCall.toolCallId,
  toolInput: params.toolCall.rawInput ?? {},
  // NEW: ACP permission options
  acpOptions: params.options.map(o => ({
    optionId: o.optionId,
    name: o.name,
    kind: o.kind,
  })),
});
```

### Anti-Patterns to Avoid
- **Don't create new WebSocket message types for ACP events.** Map them to existing types (`agent_message`, `tool_progress`, `permission_request`, `slash_commands`). The frontend already renders these.
- **Don't break the existing Claude/Codex permission flow.** The `acpOptions` field is additive; when absent, the UI falls back to binary Allow/Deny.
- **Don't make the AcpClientHandler know about session domain services.** Keep it as a thin handler that calls the `onEvent` callback. Translation happens in the session service layer.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ACP type definitions | Custom type interfaces | Import from `@agentclientprotocol/sdk` | SDK exports all types: `SessionUpdate`, `ToolCall`, `ToolCallUpdate`, `Plan`, `PlanEntry`, `RequestPermissionRequest`, etc. |
| Session update discriminant | Manual type narrowing | SDK's discriminated union on `sessionUpdate` field | Type-safe switch/case with exhaustive checking |
| Permission option kinds | Custom enum | `PermissionOptionKind` from SDK | Exact values: `"allow_once" \| "allow_always" \| "reject_once" \| "reject_always"` |

**Key insight:** The ACP SDK v0.14.1 exports comprehensive TypeScript types. Every `SessionUpdate` variant is a discriminated union on the `sessionUpdate` field. Use these directly rather than recreating them.

## Common Pitfalls

### Pitfall 1: requestPermission Blocks the Prompt Turn
**What goes wrong:** `AcpClientHandler.requestPermission()` is called by the ACP connection and must return a `Promise<RequestPermissionResponse>`. If not properly suspended, it either auto-approves (Phase 19 behavior) or deadlocks.
**Why it happens:** The ACP connection's JSON-RPC layer sends `session/request_permission` as a request (not notification). It expects a response before the prompt turn can continue.
**How to avoid:** Use the Promise-based permission bridge pattern. The bridge creates a Promise that suspends until the WebSocket handler resolves it. The `sendAcpMessage` call in session.service.ts already runs in fire-and-forget mode, so the prompt() call blocking is fine.
**Warning signs:** Permission requests not appearing in the UI; agent immediately executing tools despite permission mode being enabled.

### Pitfall 2: ACP Tool Calls Use Different ID Format
**What goes wrong:** ACP `ToolCallId` is an opaque string from the agent, not the Anthropic API `toolu_xxxx` format. Frontend code that expects a specific format may break.
**Why it happens:** The ACP SDK abstracts over different providers. Tool call IDs come from the agent implementation.
**How to avoid:** Use the `toolCallId` as-is. The frontend tool rendering already handles arbitrary string IDs from the `id` field in `content_block_start` events.
**Warning signs:** Tool call rendering showing "unknown" or missing tool calls.

### Pitfall 3: Plan Updates Replace the Entire Plan
**What goes wrong:** Treating plan updates as incremental when they are full replacements.
**Why it happens:** The ACP spec states: "When updating a plan, the agent must send a complete list of all entries with their current status. The client replaces the entire plan with each update."
**How to avoid:** On every `plan` session update, replace the entire plan state in the frontend. Don't try to merge or diff.
**Warning signs:** Stale plan entries remaining visible after agent removes them.

### Pitfall 4: Permission Response Carries optionId, Not boolean
**What goes wrong:** Sending `allow: true/false` back to ACP when it expects `optionId: string`.
**Why it happens:** The existing FF permission flow uses `allow: boolean`. ACP uses `outcome: { outcome: 'selected', optionId: string }`.
**How to avoid:** Extend the WebSocket `permission_response` schema to include an optional `optionId` field. When `optionId` is present (ACP session), use it directly. When absent (legacy Claude session), fall back to the boolean `allow` field.
**Warning signs:** Agent receiving wrong permission type; "allow_always" being treated as "allow_once".

### Pitfall 5: ContentChunk.content Is a ContentBlock, Not a String
**What goes wrong:** Treating `agent_message_chunk.content` as a text string when it's actually a `ContentBlock` (discriminated union: text, image, audio, resource_link, resource).
**Why it happens:** Phase 19 handler passes `update.content` directly as `ClaudeContentItem`, which works for text but would break for other content types.
**How to avoid:** Explicitly check `content.type === 'text'` and extract `content.text`. Handle other content types appropriately (image, resource).
**Warning signs:** `[object Object]` appearing in the chat instead of message text.

### Pitfall 6: agent_thought_chunk Is Distinct from agent_message_chunk
**What goes wrong:** Treating thoughts as regular messages, or vice versa.
**Why it happens:** Both are `ContentChunk` variants with the same structure but different `sessionUpdate` discriminants.
**How to avoid:** `agent_thought_chunk` should update `latestThinking` state and optionally render as a collapsible thinking block. `agent_message_chunk` should render as normal assistant text.
**Warning signs:** Thinking content appearing in the main chat, or agent messages being hidden in the thinking section.

## Code Examples

### ACP SessionUpdate Discriminated Union (from SDK types.gen.d.ts)
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 dist/schema/types.gen.d.ts
export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: "user_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_thought_chunk" })
  | (ToolCall & { sessionUpdate: "tool_call" })
  | (ToolCallUpdate & { sessionUpdate: "tool_call_update" })
  | (Plan & { sessionUpdate: "plan" })
  | (AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" })
  | (CurrentModeUpdate & { sessionUpdate: "current_mode_update" })
  | (ConfigOptionUpdate & { sessionUpdate: "config_option_update" })
  | (SessionInfoUpdate & { sessionUpdate: "session_info_update" })
  | (UsageUpdate & { sessionUpdate: "usage_update" });
```

### ACP ToolCall Type (from SDK)
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 dist/schema/types.gen.d.ts
export type ToolCall = {
  content?: Array<ToolCallContent>;
  kind?: ToolKind;  // "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
  locations?: Array<ToolCallLocation>;  // { path: string; line?: number | null }
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: ToolCallStatus;  // "pending" | "in_progress" | "completed" | "failed"
  title: string;
  toolCallId: ToolCallId;
};

export type ToolCallUpdate = {
  content?: Array<ToolCallContent> | null;
  kind?: ToolKind | null;
  locations?: Array<ToolCallLocation> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: ToolCallStatus | null;
  title?: string | null;
  toolCallId: ToolCallId;
};
```

### ACP Plan Type (from SDK)
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 dist/schema/types.gen.d.ts
export type Plan = {
  entries: Array<PlanEntry>;
};

export type PlanEntry = {
  content: string;
  priority: PlanEntryPriority;  // "high" | "medium" | "low"
  status: PlanEntryStatus;      // "pending" | "in_progress" | "completed"
};
```

### ACP Permission Types (from SDK)
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 dist/schema/types.gen.d.ts
export type RequestPermissionRequest = {
  options: Array<PermissionOption>;
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
};

export type PermissionOption = {
  kind: PermissionOptionKind;  // "allow_once" | "allow_always" | "reject_once" | "reject_always"
  name: string;
  optionId: PermissionOptionId;  // string
};

export type RequestPermissionResponse = {
  outcome: RequestPermissionOutcome;
};

export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | (SelectedPermissionOutcome & { outcome: "selected" });

export type SelectedPermissionOutcome = {
  optionId: PermissionOptionId;
};
```

### ACP Available Commands (from SDK)
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 dist/schema/types.gen.d.ts
export type AvailableCommandsUpdate = {
  availableCommands: Array<AvailableCommand>;
};

export type AvailableCommand = {
  description: string;
  input?: AvailableCommandInput | null;
  name: string;
};

export type AvailableCommandInput = UnstructuredCommandInput;

export type UnstructuredCommandInput = {
  hint: string;
};
```

### Existing FF Permission WebSocket Flow (Current State)
```typescript
// Backend emits (from chat-event-forwarder.service.ts):
sessionDomainService.emitDelta(dbSessionId, {
  type: 'permission_request',
  requestId: request.requestId,
  toolName: request.toolName,
  toolInput: request.input,
  planContent: planContent,
});

// Frontend handles (from reducer/slices/requests.ts):
// WS_PERMISSION_REQUEST -> state.pendingRequest = { type: 'permission', request }

// User clicks Allow/Deny (from permission-prompt.tsx):
// onApprove(requestId, allow: boolean)

// Frontend sends via WebSocket:
// { type: 'permission_response', requestId, allow: boolean }

// Backend handles (from permission-response.handler.ts):
// sessionService.respondToPermissionRequest(sessionId, requestId, allow)
```

### Existing FF PermissionRequest Type (from interaction.ts)
```typescript
// Source: src/shared/claude/protocol/interaction.ts
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
  planContent?: string | null;
}
```

### Existing FF Slash Command Palette Data Structure
```typescript
// Source: src/shared/claude/protocol/models.ts
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

// ACP AvailableCommand maps to:
// { name: cmd.name, description: cmd.description, argumentHint: cmd.input?.hint }
```

### Mapping: ACP tool_call -> FF content_block_start
```typescript
// Current Phase 19 translation (from session.service.ts setupAcpEventHandler):
case 'acp_tool_call': {
  sessionDomainService.emitDelta(sid, {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: tc.toolCallId,
          name: tc.title,
          input: {},
        },
      },
    },
  });
  break;
}
// Phase 20 needs to also emit:
// - tool_progress for status updates
// - locations for click-to-open
// - status lifecycle (pending -> in_progress -> completed/failed)
```

## State of the Art

| Old Approach (Phase 19) | Current Approach (Phase 20) | Impact |
|------------------------|---------------------------|--------|
| Auto-approve permissions | Promise-based permission bridge with multi-option UI | Users can allow_once, allow_always, reject_once, reject_always |
| Log-only for thoughts, plans, commands | Full translation to delta events | Frontend renders all ACP event types |
| Minimal tool_call mapping (title/id only) | Full mapping with status lifecycle, kind, content, locations | Rich tool call rendering with click-to-open |
| Hardcoded text content extraction | ContentBlock type checking | Correct handling of text, images, resources |

## Detailed Gap Analysis

### ACP Events: Phase 19 Status -> Phase 20 Required

| ACP SessionUpdate | Phase 19 Status | Phase 20 Requirement | FF Delta Target |
|-------------------|----------------|---------------------|----------------|
| `agent_message_chunk` | Forwarded as agent_message | Improve ContentBlock type handling | `agent_message` (stream_event or assistant) |
| `agent_thought_chunk` | Logged only | Translate to thinking content | `agent_message` with thinking content_block |
| `tool_call` | Forwarded with title/id/status | Add kind, content, locations | `agent_message` (content_block_start tool_use) |
| `tool_call_update` | Forwarded as tool_progress | Add status lifecycle, content, locations | `tool_progress` + optional `agent_message` updates |
| `plan` | Logged only | Translate to plan view | NEW: plan delta event type or task_notification |
| `available_commands_update` | Logged only | Translate to slash commands | `slash_commands` |
| `config_option_update` | Logged only | Could forward or log | Low priority, log is acceptable |
| `current_mode_update` | Logged only | Could forward or log | Low priority, log is acceptable |
| `session_info_update` | Logged only | Could forward or log | Low priority, log is acceptable |
| `usage_update` | Logged only | Translate to token stats | Update tokenStats via result-like event |
| `user_message_chunk` | Logged only | Could forward or log | Low priority, user already sees their own messages |

### Permission Flow: Phase 19 -> Phase 20

| Aspect | Phase 19 | Phase 20 |
|--------|----------|----------|
| AcpClientHandler.requestPermission() | Auto-approves with first allow option | Returns Promise that suspends until user responds |
| Backend permission storage | Not stored | Stored via AcpPermissionBridge |
| WebSocket emission | None | Emits `permission_request` with `acpOptions` array |
| Frontend rendering | N/A | PermissionPrompt renders 4 distinct option buttons |
| Response schema | N/A | `permission_response` includes optional `optionId` |
| Backend resolution | N/A | Resolves bridge Promise with selected optionId |

### Plan Rendering Options

The FF frontend doesn't have a dedicated "plan view" component for ACP-style plans. Options:

1. **Reuse existing plan approval UI**: The `PlanApprovalPrompt` in permission-prompt.tsx renders markdown plans. ACP plans could be formatted as markdown with status indicators (checkboxes, etc.) and rendered in a similar card.
2. **Create a new plan panel component**: A dedicated component that shows PlanEntry items with status indicators (pending/in_progress/completed) and priority badges.
3. **Add a new WebSocket message type**: Add `acp_plan` to `WebSocketMessagePayloadByType` and create a dedicated reducer slice.

**Recommendation:** Option 2 or 3. ACP plans are structured data (entries with status/priority), not markdown. A dedicated component is cleaner. Adding a new `acp_plan` delta event type keeps the ACP plan model separate from the existing Claude plan approval flow. The frontend should store the latest plan state and render it as a collapsible task list.

### Slash Command Translation

ACP `AvailableCommand` maps directly to FF `CommandInfo`:

```typescript
// ACP -> FF mapping
const commandInfo: CommandInfo = {
  name: acpCommand.name,
  description: acpCommand.description,
  argumentHint: acpCommand.input?.hint,
};
```

The existing `SlashCommandPalette` component and `slash_commands` WebSocket event are a perfect fit. No new components needed.

### Tool Call File Location Tracking (EVENT-07)

ACP `ToolCall` and `ToolCallUpdate` include a `locations` field: `Array<ToolCallLocation>` where each location has `path: string` and optional `line?: number`. This needs to be:

1. Forwarded through the delta pipeline to the frontend
2. Stored per-tool-call in the frontend state
3. Rendered as clickable links that open files in the user's IDE

The existing `tool_progress` event type doesn't carry location data. Options:
- Extend `tool_progress` with optional `locations` field
- Store locations on the tool_use ChatMessage and render from there
- Emit tool call starts via `content_block_start` with location metadata in a side-channel

**Recommendation:** Store locations on the tool_use `content_block_start` event data and update them when `tool_call_update` arrives with new locations. The frontend's existing tool rendering already has access to the message data where it can read locations.

## Open Questions

1. **Plan rendering component scope**
   - What we know: ACP Plan has entries with content/status/priority. FF has no existing ACP-plan renderer.
   - What's unclear: How prominent should the plan be? A sidebar? Inline in chat? A collapsible panel?
   - Recommendation: Start with a simple inline collapsible task list within the chat area (similar to how thinking is rendered in the AgentLiveDock). Can be promoted to a sidebar later.

2. **config_option_update and current_mode_update rendering**
   - What we know: ACP sends these for mode changes and config toggles.
   - What's unclear: Whether the FF UI should expose mode switching or config options for ACP sessions.
   - Recommendation: Log only for Phase 20. These are low priority compared to core events. Can be wired up in a later phase if needed.

3. **Permission timeout/cancellation**
   - What we know: ACP spec says "If the client cancels the prompt turn via session/cancel, it MUST respond to this request with RequestPermissionOutcome::Cancelled."
   - What's unclear: What happens if the user navigates away from the session while a permission is pending?
   - Recommendation: Use the existing `PendingInteractiveRequest` pattern to store ACP permissions. On session stop/cancel, call `bridge.cancelAll()` to resolve all pending promises with `cancelled` outcome.

4. **ContentChunk non-text content types**
   - What we know: ACP ContentBlock includes text, image, audio, resource_link, resource types.
   - What's unclear: Which content types Claude Code ACP adapter actually sends.
   - Recommendation: Handle text robustly. Log other types with a "TODO: render non-text ACP content" message. Most messages from Claude Code will be text.

## Sources

### Primary (HIGH confidence)
- `@agentclientprotocol/sdk@0.14.1` dist/schema/types.gen.d.ts - All ACP types verified directly from installed package
- `@agentclientprotocol/sdk@0.14.1` dist/acp.d.ts - Client interface with requestPermission and sessionUpdate contracts
- `src/backend/domains/session/acp/acp-client-handler.ts` - Current Phase 19 event handler implementation
- `src/backend/domains/session/lifecycle/session.service.ts` - Current ACP event wiring in setupAcpEventHandler
- `src/shared/claude/protocol/websocket.ts` - Complete SessionDeltaEvent and WebSocketMessage type definitions
- `src/shared/claude/protocol/content.ts` - ClaudeContentItem and ClaudeStreamEvent types
- `src/shared/claude/protocol/interaction.ts` - PermissionRequest and UserQuestionRequest types
- `src/shared/websocket/chat-message.schema.ts` - WebSocket message schema including permission_response
- `src/components/chat/permission-prompt.tsx` - Current binary Allow/Deny permission UI
- `src/components/chat/reducer/types.ts` - Full ChatState and ChatAction definitions
- `src/components/chat/use-chat-websocket.ts` - Chat WebSocket hook implementation
- `src/components/chat/use-chat-transport.ts` - WebSocket message handling and action dispatch
- `src/components/chat/slash-command-palette.tsx` - Existing slash command rendering
- `src/components/chat/agent-live-dock.tsx` - Live activity dock with thinking and tool rendering
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` - Claude permission and event forwarding
- `src/backend/domains/session/chat/chat-message-handlers/handlers/permission-response.handler.ts` - Permission response handling
- `src/backend/domains/session/codex/codex-event-translator.ts` - Reference pattern for event translation

### Secondary (MEDIUM confidence)
- ACP protocol docs referenced in SDK JSDoc comments (agentclientprotocol.com)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already installed and in use
- Architecture: HIGH - follows established CodexEventTranslator pattern, all FF types well-documented
- ACP SDK types: HIGH - verified directly from installed node_modules
- Event translation mapping: HIGH - clear 1:1 mapping between ACP SessionUpdate variants and FF delta types
- Permission flow: HIGH - ACP RequestPermission contract is explicit, Promise-based bridge is straightforward
- Plan rendering: MEDIUM - no existing plan component, need new UI
- Pitfalls: HIGH - verified through code reading of existing implementations

**Research date:** 2026-02-13
**Valid until:** 30 days (stable - SDK version pinned, FF architecture mature)
