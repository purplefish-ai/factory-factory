# Phase 21: Config Options + Unified Runtime - Research

**Researched:** 2026-02-13
**Domain:** ACP config options protocol, session resume, runtime manager unification
**Confidence:** HIGH

## Summary

Phase 21 completes the ACP integration by implementing three interlocked capabilities: (1) agent-driven config options (model, mode, thought level) parsed from `session/new` and `config_option_update` notifications, surfaced in the UI as grouped selectors, and set via `session/set_config_option`; (2) session resume via `session/load` gated on the agent's `loadSession` capability; and (3) a unified `AcpRuntimeManager` that serves both Claude and Codex providers, eliminating `ClaudeRuntimeManager` and `CodexAppServerManager`.

The ACP SDK (`@agentclientprotocol/sdk@0.14.1`) already provides complete typed support for all three areas. `NewSessionResponse.configOptions` returns `SessionConfigOption[]` with `type: "select"`, `category` (mode/model/thought_level/custom), `currentValue`, and grouped or flat option arrays. `SetSessionConfigOptionRequest` takes `configId` + `value` + `sessionId` and returns the full updated `configOptions` array. `ConfigOptionUpdate` is pushed via `session_update` notifications with `sessionUpdate: "config_option_update"`. `LoadSessionRequest` takes `sessionId` + `cwd` + `mcpServers` and returns the same shape as `NewSessionResponse` (including `configOptions`). The `ClientSideConnection` class exposes `loadSession()`, `setSessionConfigOption()`, and handles the notification routing.

The existing codebase has explicit Phase 21 deferral points: `AcpEventTranslator.translateSessionUpdate()` returns `[]` for `config_option_update` (line 46), `sessionService.setSessionModel()` and `setSessionThinkingBudget()` both have early returns for ACP sessions with Phase 21 comments, and the `AcpProcessHandle` already stores `agentCapabilities` from the initialize response. The current `ChatBarCapabilities` system (`chat-capabilities.ts`) uses a static provider-based approach -- Phase 21 replaces this with dynamic agent-reported config options for ACP sessions.

**Primary recommendation:** Store `configOptions` from `session/new` response on `AcpProcessHandle`, translate `config_option_update` events to a new `config_options_update` WebSocket message type, add `set_config_option` chat message handler, and migrate both Claude and Codex providers to use `AcpRuntimeManager` as the sole runtime (behind `useAcp` flag that becomes the default).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @agentclientprotocol/sdk | 0.14.1 | ACP types, connection, config option protocol | Already installed; provides SessionConfigOption, SetSessionConfigOptionRequest/Response, ConfigOptionUpdate, LoadSessionRequest/Response types |
| React | existing | Frontend rendering of config option selectors | Current frontend framework |
| Zod | existing | Schema validation for new WS message types | Used throughout for chat message validation |
| shadcn/ui | existing | Dropdown selectors for config options | Current UI component library |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | existing | Icons for config option dropdowns | Category-specific icons (model, mode, thought) |
| p-limit | existing | Concurrency control in runtime manager | Already used in AcpRuntimeManager |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New `config_options_update` WS type | Reuse `chat_capabilities` WS type | New type is cleaner -- config options have different shape than ChatBarCapabilities; converting loses information (grouped options, descriptions, IDs) |
| Dynamic ACP config selectors | Extend ChatBarCapabilities with ACP fields | ChatBarCapabilities is provider-static; ACP config options are agent-dynamic with arbitrary categories. Keep them as parallel systems initially, with ChatBarCapabilities derived from config options for ACP sessions |
| Migrating Claude/Codex to AcpRuntimeManager | Keeping all three managers | Phase goal explicitly requires RUNTIME-08: unified manager. But migration should be incremental -- ACP adapter packages must exist for both providers |

## Architecture Patterns

### Recommended Project Structure
```
src/backend/domains/session/acp/
  acp-process-handle.ts       # MODIFY: add configOptions field, loadSession capability check
  acp-event-translator.ts     # MODIFY: translate config_option_update -> WebSocket event
  acp-runtime-manager.ts      # MODIFY: capture configOptions from newSession/loadSession response
                               #         add setConfigOption() and loadSession() methods
  types.ts                    # MODIFY: add AcpConfigState type
  index.ts                    # MODIFY: export new types

src/backend/domains/session/lifecycle/
  session.service.ts           # MODIFY: wire config options from newSession response,
                               #         handle config_option_update events,
                               #         implement setSessionConfigOption() for ACP,
                               #         implement ACP session resume via loadSession(),
                               #         remove legacy ClaudeRuntimeManager/CodexAppServerManager usage

src/shared/claude/protocol/
  websocket.ts                # MODIFY: add config_options_update WS message type

src/shared/websocket/
  chat-message.schema.ts      # MODIFY: add set_config_option message type

src/backend/domains/session/chat/chat-message-handlers/
  handlers/set-config-option.handler.ts  # NEW: handle set_config_option WS message
  registry.ts                            # MODIFY: register new handler

src/components/chat/
  reducer/types.ts             # MODIFY: add AcpConfigOption types, config_options_update action
  reducer/state.ts             # MODIFY: add acpConfigOptions to ChatState
  reducer/slices/settings.ts   # MODIFY: handle CONFIG_OPTIONS_UPDATE action
  chat-input/components/acp-config-selector.tsx  # NEW: generic config option dropdown
  chat-input/chat-input.tsx    # MODIFY: render ACP config selectors when available

src/backend/domains/session/runtime/
  provider-runtime-manager.ts  # MODIFY: extend interface with config/load methods
  index.ts                     # MODIFY: remove ClaudeRuntimeManager/CodexAppServerManager exports
  claude-runtime-manager.ts    # DEPRECATE/REMOVE after migration
  codex-app-server-manager.ts  # DEPRECATE/REMOVE after migration
```

### Pattern 1: Config Options Lifecycle (Agent-Driven State)
**What:** Config options flow from agent to client, not vice versa. The agent is always authoritative.
**When to use:** For all model/mode/thinking controls in ACP sessions.
**Flow:**
```
1. session/new response -> configOptions[] -> store on AcpProcessHandle
2. Frontend receives config_options_update WS message -> renders selectors
3. User selects option -> set_config_option WS message -> backend
4. Backend calls connection.setSessionConfigOption() -> agent responds with updated configOptions
5. Backend emits config_options_update WS message -> frontend updates
6. Agent may also push config_option_update notification -> same path as step 5
```
**Example:**
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 types.gen.d.ts
// Parsing config options from session/new response
const sessionResult = await connection.newSession({
  cwd: options.workingDir,
  mcpServers: [],
});

// Store initial config options
handle.configOptions = sessionResult.configOptions ?? [];
handle.providerSessionId = sessionResult.sessionId;

// Send initial config options to frontend
this.emitConfigOptionsUpdate(sessionId, handle.configOptions);
```

### Pattern 2: Capability-Gated Session Resume
**What:** Check `agentCapabilities.loadSession` before attempting `session/load`. Fall back to `session/new` when absent.
**When to use:** When connecting to a session that has a prior `providerSessionId` stored.
**Example:**
```typescript
// Source: @agentclientprotocol/sdk@0.14.1 types.gen.d.ts
// AgentCapabilities.loadSession?: boolean

const canResume = handle.agentCapabilities.loadSession === true;
const storedSessionId = session.claudeSessionId; // providerSessionId from DB

if (canResume && storedSessionId) {
  const loadResult = await connection.loadSession({
    sessionId: storedSessionId,
    cwd: options.workingDir,
    mcpServers: [],
  });
  handle.configOptions = loadResult.configOptions ?? [];
} else {
  const newResult = await connection.newSession({
    cwd: options.workingDir,
    mcpServers: [],
  });
  handle.configOptions = newResult.configOptions ?? [];
}
```

### Pattern 3: Config Options -> ChatBarCapabilities Bridge
**What:** For ACP sessions, derive `ChatBarCapabilities` from agent-reported `configOptions` so existing UI code works.
**When to use:** When the frontend needs ChatBarCapabilities for an ACP session.
**Example:**
```typescript
// Convert ACP SessionConfigOption[] to ChatBarCapabilities
function createAcpChatBarCapabilities(
  configOptions: SessionConfigOption[]
): ChatBarCapabilities {
  const modelConfig = configOptions.find(o => o.category === 'model');
  const modeConfig = configOptions.find(o => o.category === 'mode');
  const thoughtConfig = configOptions.find(o => o.category === 'thought_level');

  return {
    provider: 'CLAUDE', // or determined from session
    model: {
      enabled: !!modelConfig,
      options: flattenConfigOptions(modelConfig),
      selected: modelConfig?.currentValue,
    },
    reasoning: { enabled: false, options: [] },
    thinking: {
      enabled: !!thoughtConfig,
      defaultBudget: 10_000,
    },
    // ... derive remaining from config options or defaults
  };
}
```

### Pattern 4: Unified Runtime Manager Migration
**What:** Route all sessions through `AcpRuntimeManager`. Claude and Codex both have ACP adapter binaries (`claude-code-acp`, `codex-acp`).
**When to use:** RUNTIME-08 -- the final state where `ClaudeRuntimeManager` and `CodexAppServerManager` are eliminated.
**Approach:**
1. `AcpRuntimeManager` already supports both providers via `options.provider` ('CLAUDE' | 'CODEX')
2. `createClient()` already resolves the correct binary based on provider
3. Remove the `useAcp` flag gate -- make ACP the default path
4. Remove `ClaudeRuntimeManager` singleton usage from `SessionService`
5. Remove `CodexAppServerManager` singleton usage from `SessionService`
6. Update `SessionProviderAdapter` implementations or replace with unified ACP adapter
7. Retain legacy managers temporarily for fallback until verified stable

### Anti-Patterns to Avoid
- **Client-side config state as source of truth:** Never let the frontend maintain config option state independently. The agent's response is always authoritative. Frontend is read-only display + set request sender.
- **Hardcoded config option categories:** Don't assume only mode/model/thought_level exist. Handle unknown categories gracefully (render as generic dropdown).
- **Converting SessionConfigOption to ChatBarCapabilities and back:** Don't round-trip. Keep the raw config options alongside ChatBarCapabilities; derive ChatBarCapabilities from config options for backward compatibility.
- **Blocking on setSessionConfigOption during prompt:** The ACP spec says config can be set "at any time during a session." Don't prevent config changes while a prompt is in flight.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Config option select UI | Custom dropdown from scratch | Existing `ModelSelector` pattern + shadcn `DropdownMenu` | Already proven pattern in the codebase for model/reasoning selectors |
| ACP protocol serialization | Manual JSON-RPC framing | `ClientSideConnection.setSessionConfigOption()` / `.loadSession()` | SDK handles framing, request IDs, and response routing |
| Config option grouping | Custom grouping logic | `SessionConfigSelectGroup` from SDK types | SDK already defines grouped vs flat option arrays |
| Config state synchronization | WebSocket polling | Push-based `config_option_update` notification + authoritative response from `setSessionConfigOption` | Agent pushes changes; we just render |

**Key insight:** The ACP SDK provides complete typed interfaces for the entire config options lifecycle. The work is in wiring these through the FF delta pipeline and rendering them, not in implementing the protocol.

## Common Pitfalls

### Pitfall 1: Config Options Arriving Before Frontend is Ready
**What goes wrong:** `session/new` returns `configOptions` before the frontend has connected or loaded. The initial config state is lost.
**Why it happens:** The ACP handshake completes server-side during session creation, but the WebSocket connection may not be established yet.
**How to avoid:** Store `configOptions` on `AcpProcessHandle`. When the frontend sends `load_session`, include the stored config options in the response (similar to how `chat_capabilities` is sent during load).
**Warning signs:** Config selectors appear empty after session start but populate after the first agent notification.

### Pitfall 2: Stale Config Options After setConfigOption
**What goes wrong:** The UI shows the old value briefly before the agent's authoritative response arrives.
**Why it happens:** Optimistic update on the frontend before the server round-trip completes.
**How to avoid:** Do NOT optimistically update the frontend. Send the request, wait for the server to emit the authoritative `config_options_update` from the agent's response. The `setSessionConfigOption` response includes the full `configOptions[]` -- emit that as the update.
**Warning signs:** Brief flicker when changing config options, or options reverting after appearing to change.

### Pitfall 3: Grouped vs Flat Option Arrays
**What goes wrong:** Code assumes `options` is always `SessionConfigSelectOption[]` but the SDK allows `SessionConfigSelectGroup[]` (option groups with headers).
**Why it happens:** The `SessionConfigSelectOptions` type is a union: `Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>`.
**How to avoid:** Check the first element for a `group` property to distinguish flat from grouped arrays. Render grouped options with section headers in the dropdown.
**Warning signs:** Type errors or empty dropdowns when an agent returns grouped config options.

### Pitfall 4: Unified Runtime Migration Breaking Existing Sessions
**What goes wrong:** Removing `ClaudeRuntimeManager` breaks sessions that are currently in-flight using the legacy manager.
**Why it happens:** The migration happens at the singleton level, not per-session.
**How to avoid:** Make the migration incremental: first make ACP the default for new sessions, then drain legacy sessions. Keep legacy managers importable but not instantiated as singletons until all references are removed.
**Warning signs:** Existing running sessions crash or become unresponsive after deployment.

### Pitfall 5: loadSession Failure Not Handled Gracefully
**What goes wrong:** `loadSession` throws (session expired, agent doesn't support it) and the UI shows an error instead of gracefully falling back to new session.
**Why it happens:** Missing try/catch around the loadSession call, or capability check is wrong.
**How to avoid:** Always gate on `agentCapabilities.loadSession === true`. Wrap `loadSession()` in try/catch and fall back to `newSession()` on any error. Log the fallback.
**Warning signs:** "Session not found" errors when resuming sessions, or users unable to reconnect.

### Pitfall 6: Config Option Category Rendering Assumptions
**What goes wrong:** A new category (e.g., `_custom_safety`) appears and the UI crashes or hides it.
**Why it happens:** Code uses exhaustive switch on known categories without a default case.
**How to avoid:** Always render unknown categories as generic dropdowns. The `SessionConfigOptionCategory` type is `"mode" | "model" | "thought_level" | string` -- the `| string` is intentional for extensibility.
**Warning signs:** Console errors about unhandled categories, or config options silently disappearing.

## Code Examples

### Translating config_option_update in AcpEventTranslator
```typescript
// Source: existing pattern in acp-event-translator.ts, extending for config_option_update
case 'config_option_update': {
  const configUpdate = update as Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>;
  return [{
    type: 'config_options_update',
    configOptions: configUpdate.configOptions,
  } as SessionDeltaEvent];
}
```

### New set_config_option WebSocket Message Schema
```typescript
// Source: pattern from chat-message.schema.ts
z.object({
  type: z.literal('set_config_option'),
  configId: z.string().min(1),
  value: z.string().min(1),
})
```

### New set_config_option Handler
```typescript
// Source: pattern from set-model.handler.ts
export function createSetConfigOptionHandler(): ChatMessageHandler<SetConfigOptionMessage> {
  return async ({ ws, sessionId, message }) => {
    try {
      const updatedOptions = await sessionService.setSessionConfigOption(
        sessionId,
        message.configId,
        message.value
      );
      // The response is authoritative -- emit to all subscribers via emitDelta
      // (not just the requesting ws, because other tabs/views should also update)
    } catch (error) {
      sendWebSocketError(ws, `Failed to set config option: ${errorMessage}`);
    }
  };
}
```

### Session Service setSessionConfigOption Method
```typescript
// Source: ACP SDK ClientSideConnection.setSessionConfigOption()
async setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string
): Promise<void> {
  const handle = acpRuntimeManager.getClient(sessionId);
  if (!handle) {
    throw new Error(`No ACP session found for sessionId: ${sessionId}`);
  }

  const response = await handle.connection.setSessionConfigOption({
    sessionId: handle.providerSessionId,
    configId,
    value,
  });

  // Update stored config options
  handle.configOptions = response.configOptions;

  // Emit to frontend via delta pipeline
  sessionDomainService.emitDelta(sessionId, {
    type: 'config_options_update',
    configOptions: response.configOptions,
  });
}
```

### ACP Session Resume with Capability Check
```typescript
// Source: ACP SDK types - AgentCapabilities.loadSession, ClientSideConnection.loadSession()
private async createOrResumeAcpSession(
  connection: ClientSideConnection,
  options: AcpClientOptions,
  agentCapabilities: Record<string, unknown>,
  storedProviderSessionId: string | null
): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
  const canResume = agentCapabilities.loadSession === true;

  if (canResume && storedProviderSessionId) {
    try {
      const result = await connection.loadSession({
        sessionId: storedProviderSessionId,
        cwd: options.workingDir,
        mcpServers: [],
      });
      return {
        sessionId: result.sessionId ?? storedProviderSessionId,
        configOptions: result.configOptions ?? [],
      };
    } catch (error) {
      logger.warn('loadSession failed, falling back to newSession', {
        storedProviderSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fallback to new session
  const result = await connection.newSession({
    cwd: options.workingDir,
    mcpServers: [],
  });
  return {
    sessionId: result.sessionId,
    configOptions: result.configOptions ?? [],
  };
}
```

### Frontend Config Options Rendering
```typescript
// Source: pattern from model-selector.tsx
interface AcpConfigSelectorProps {
  configOption: {
    id: string;
    name: string;
    category?: string;
    currentValue: string;
    options: Array<{ value: string; name: string; description?: string }>;
  };
  onSelect: (configId: string, value: string) => void;
  disabled?: boolean;
}

function AcpConfigSelector({ configOption, onSelect, disabled }: AcpConfigSelectorProps) {
  const currentOption = configOption.options.find(o => o.value === configOption.currentValue);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          {currentOption?.name ?? configOption.name}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={configOption.currentValue}
          onValueChange={(value) => onSelect(configOption.id, value)}
        >
          {configOption.options.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              {opt.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded model list in `createClaudeChatBarCapabilities()` | Agent-reported configOptions with dynamic model list | Phase 21 | Model/mode selectors populated from agent, not FF code |
| `set_model` + `set_thinking_budget` WS messages | Unified `set_config_option` message for all config types | Phase 21 | Single handler replaces two separate handlers for ACP sessions |
| `ClaudeRuntimeManager` + `CodexAppServerManager` | Unified `AcpRuntimeManager` | Phase 21 | One runtime manager, two ACP adapter binaries |
| `useAcp` flag opt-in | ACP as default path | Phase 21 | Legacy code path removed |
| Claude sessions via process stdio events | Claude sessions via ACP protocol | Phase 19-21 | Consistent protocol for all providers |

**Deprecated/outdated after Phase 21:**
- `ClaudeRuntimeManager`: Replaced by `AcpRuntimeManager` with `provider: 'CLAUDE'`
- `CodexAppServerManager`: Replaced by `AcpRuntimeManager` with `provider: 'CODEX'`
- `createClaudeChatBarCapabilities()` for ACP sessions: Replaced by config-options-derived capabilities
- `createCodexChatBarCapabilities()` for ACP sessions: Same replacement
- `set_model` handler for ACP sessions: Replaced by `set_config_option`
- `set_thinking_budget` handler for ACP sessions: Replaced by `set_config_option`

## Open Questions

1. **Should legacy `set_model`/`set_thinking_budget` handlers remain for non-ACP sessions?**
   - What we know: Legacy Claude sessions use `ClaudeClient` (not ACP) and may still need these handlers during migration.
   - What's unclear: Whether RUNTIME-08 means ALL sessions go through ACP immediately, or just that the runtime infrastructure is unified.
   - Recommendation: Keep legacy handlers but gate them to non-ACP sessions. The existing early-return pattern (already in `setSessionModel()`) already does this. Remove them only when the `useAcp` flag is removed entirely.

2. **How to handle the `config_options_update` timing with ChatBarCapabilities?**
   - What we know: The frontend currently relies on `ChatBarCapabilities` for determining what controls to render. ACP config options are a superset.
   - What's unclear: Whether to replace `ChatBarCapabilities` entirely or derive it from config options.
   - Recommendation: Derive `ChatBarCapabilities` from ACP config options for ACP sessions (to maintain backward compatibility with existing UI code), but also pass raw config options to the frontend so new ACP-specific UI can render them. Dual-path until the old `ChatBarCapabilities` system can be retired.

3. **CodexAppServerManager uses a singleton shared-process model; AcpRuntimeManager uses per-session processes. Are these equivalent?**
   - What we know: `CodexAppServerManager` is a single long-lived process that multiplexes sessions via thread IDs. `AcpRuntimeManager` spawns one process per session. The ACP adapter `codex-acp` may handle this internally.
   - What's unclear: Whether `codex-acp` is a thin wrapper that talks to the shared Codex process, or whether it manages its own process lifecycle.
   - Recommendation: Verify behavior by testing `codex-acp` binary. If it manages its own process, the per-session model works. If it expects a shared server, we may need to add connection pooling to `AcpRuntimeManager`. This is a MEDIUM confidence area.

4. **Session resume: should the FF `load_session` handler (which handles frontend page load) trigger ACP `session/load`?**
   - What we know: The current `load_session` handler (`load-session.handler.ts`) handles hydration -- loading transcript from disk/DB for the frontend. ACP `session/load` tells the agent to restore session state.
   - What's unclear: Whether these should be unified (page load triggers ACP resume) or kept separate (ACP resume only on explicit reconnection).
   - Recommendation: Trigger ACP `session/load` during `createAcpClient()` when a stored `providerSessionId` exists and the agent supports `loadSession`. The frontend `load_session` handler remains as-is for hydration. ACP session/load is a backend concern during client creation.

## Sources

### Primary (HIGH confidence)
- `@agentclientprotocol/sdk@0.14.1` (installed) - types.gen.d.ts for SessionConfigOption, SetSessionConfigOptionRequest/Response, ConfigOptionUpdate, LoadSessionRequest/Response, AgentCapabilities.loadSession, SessionConfigOptionCategory
- `@agentclientprotocol/sdk@0.14.1` (installed) - acp.d.ts for ClientSideConnection.setSessionConfigOption(), .loadSession() method signatures
- Codebase analysis - `src/backend/domains/session/acp/` module (acp-runtime-manager.ts, acp-event-translator.ts, acp-client-handler.ts, acp-process-handle.ts, types.ts)
- Codebase analysis - `src/backend/domains/session/runtime/` module (claude-runtime-manager.ts, codex-app-server-manager.ts, provider-runtime-manager.ts)
- Codebase analysis - `src/backend/domains/session/lifecycle/session.service.ts` (config option deferral comments at lines 807-809, 834-836; ACP event handler setup; getOrCreateSessionClient with useAcp flag)
- Codebase analysis - `src/shared/claude/protocol/websocket.ts` (WebSocketMessagePayloadByType, SessionDeltaEvent union)
- Codebase analysis - `src/shared/chat-capabilities.ts` (ChatBarCapabilities, createClaudeChatBarCapabilities, createCodexChatBarCapabilities)
- Codebase analysis - `src/shared/websocket/chat-message.schema.ts` (ChatMessageSchema discriminated union)
- Codebase analysis - `src/backend/domains/session/chat/chat-message-handlers/registry.ts` (handler registration pattern)
- Codebase analysis - `src/components/chat/chat-input/components/model-selector.tsx` (existing dropdown selector pattern)

### Secondary (MEDIUM confidence)
- Phase 20 RESEARCH.md - patterns for AcpEventTranslator, delta pipeline, and permission bridge (verified against implementation)
- Phase 19/20 prior decisions - AcpProvider inline type, dependency-cruiser rules, fire-and-forget prompt dispatch, stateless translator pattern

### Tertiary (LOW confidence)
- `codex-acp` binary behavior with shared vs per-session process model - needs runtime testing

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All types verified from installed SDK, all codebase patterns verified from source
- Architecture: HIGH - Clear extension points exist (Phase 21 deferral comments, existing handler patterns, AcpProcessHandle.agentCapabilities already stored)
- Config options protocol: HIGH - Full type definitions available in SDK, methods exist on ClientSideConnection
- Session resume: HIGH - loadSession method and capability flag verified in SDK types
- Unified runtime: MEDIUM - AcpRuntimeManager already handles both providers, but CodexAppServerManager's shared-process model may have subtle differences with per-session ACP processes
- Pitfalls: HIGH - Derived from direct code analysis of existing patterns and timing issues

**Research date:** 2026-02-13
**Valid until:** 2026-03-13 (stable -- ACP SDK version pinned, codebase patterns well-established)
