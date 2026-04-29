# Design Doc: Permission Preset Not Applied to CLAUDE Sessions

## Summary

The admin setting "Default permissions for new workspaces" (STRICT / RELAXED / YOLO) has no effect on CLAUDE-provider sessions. When a user sets this to YOLO, CLAUDE sessions still prompt for every tool call requiring approval. The root cause is that the permission preset application code (`applyConfiguredPermissionPreset`) early-returns for non-CODEX providers, and there is no alternative mechanism to configure CLAUDE sessions' permission behavior.

A secondary issue exists for CODEX sessions: the permission preset is not re-applied when resuming an existing session, so the Codex adapter may revert to its default approval policy.

---

## Context and Motivation

Factory Factory supports two ACP providers:

- **CLAUDE** — via the external `@agentclientprotocol/claude-agent-acp` binary (stdio JSON-RPC)
- **CODEX** — via an internal `codex-app-server-acp` adapter (in-process, wrapping Codex app-server)

Both providers support ACP's `requestPermission` RPC, which suspends agent execution until the user approves or denies a tool call. The user expects that setting "YOLO" globally should suppress all permission prompts for new sessions, regardless of provider.

### Two-tier permission model

Factory Factory has a two-tier permission architecture:

1. **Session-level execution mode** — configured via ACP `configOptions` with id `execution_mode`. Combines an `approvalPolicy` (`on-request` | `on-failure` | `never`) with a `sandboxMode` (`read-only` | `workspace-write` | `danger-full-access`). This determines _whether_ the agent asks for permission at all.
2. **Per-tool-call permission prompts** — when the agent does ask, it calls `requestPermission` RPC, which Factory Factory bridges to the frontend via WebSocket.

The YOLO preset maps to `approvalPolicy: "never"` + `sandboxMode: "danger-full-access"`, which should prevent the agent from ever calling `requestPermission`.

---

## Problem Statement

Despite setting "Default permissions for new workspaces" to YOLO, users are frequently prompted for permission during CLAUDE sessions. The setting appears to have no effect.

---

## Root Cause Analysis

### Root Cause 1: CLAUDE sessions skip permission preset application entirely

**Location:** `src/backend/domains/session/lifecycle/session.config.service.ts:152`

```typescript
async applyConfiguredPermissionPreset(
  sessionId: string,
  session: AgentSessionRecord,
  handle: AcpProcessHandle
): Promise<void> {
  if (handle.provider !== 'CODEX') {
    return; // <-- CLAUDE sessions exit here
  }
  // ... CODEX-only logic to set execution_mode via setConfigOption ...
}
```

This method is the sole mechanism for translating the user's permission preset (STRICT / RELAXED / YOLO) into runtime configuration. It works by calling `setConfigOption` on the Codex adapter to change the `execution_mode`, which sets `approvalPolicy` and `sandboxPolicy` for subsequent turns.

For CLAUDE sessions, the method returns immediately. The CLAUDE adapter (`claude-agent-acp`) is never told about the user's permission preference. It uses its own default behavior, which requests permission for every tool call that modifies files or executes commands.

### Root Cause 2: `permissionMode` on `AcpClientOptions` is dead code

**Location:** `src/backend/domains/session/acp/types.ts:10`

```typescript
export interface AcpClientOptions {
  // ...
  permissionMode?: string; // Set but never consumed
  // ...
}
```

In `session.lifecycle.service.ts:456`, `permissionMode` is set to `'bypassPermissions'` on every session creation:

```typescript
const clientOptions: AcpClientOptions = {
  // ...
  permissionMode: options?.permissionMode ?? 'bypassPermissions',
  // ...
};
```

However, `acp-runtime-manager.ts` never reads this field. It is not:
- Passed as a command-line argument to `claude-agent-acp`
- Set as an environment variable
- Included in the `newSession` or `loadSession` ACP calls
- Used in any conditional logic within the runtime manager

This suggests the field was intended as a mechanism for passing permission configuration to ACP processes but was never wired up.

### Root Cause 3: ACP `newSession` passes no permission parameters

**Location:** `src/backend/domains/session/acp/acp-runtime-manager.ts:899-902`

```typescript
const sessionResult = await connection.newSession({
  cwd: options.workingDir,
  mcpServers: [],
  // No permission-related parameters
});
```

The ACP protocol's `NewSessionRequest` type does not include permission-specific fields (only `cwd`, `mcpServers`, and `_meta`). However, `_meta` could potentially be used as an extension point.

### Root Cause 4: No auto-approve path in the permission bridge

**Location:** `src/backend/domains/session/acp/acp-client-handler.ts`

When a `permissionBridge` is present (i.e., all interactive sessions), every `requestPermission` call suspends and waits for user input. There is no check against the configured permission preset to auto-approve.

### Secondary Issue: CODEX sessions don't re-apply preset on resume

**Location:** `src/backend/domains/session/lifecycle/session.lifecycle.service.ts:135-137`

```typescript
if (!session.providerSessionId) {
  await this.applyConfiguredPermissionPreset(sessionId, session, handle);
}
```

For resumed CODEX sessions (where `providerSessionId` already exists from a prior run), the preset is not re-applied. The Codex adapter creates a fresh internal session state on `loadSession`, potentially reverting to default `approvalPolicy: "on-request"` behavior.

The same pattern appears at lines 249 and 262 for `getOrCreateSessionClient` and `getOrCreateSessionClientFromRecord`.

---

## Affected Code Paths

| File | Line(s) | Description |
|------|---------|-------------|
| `session.config.service.ts` | 152 | Early return for non-CODEX providers |
| `session.config.service.ts` | 591-630 | `resolveConfiguredExecutionModeTarget` — correct YOLO mapping but only reachable for CODEX |
| `session.lifecycle.service.ts` | 135, 249, 262 | Gate conditions that skip preset for resumed sessions |
| `session.lifecycle.service.ts` | 456 | Dead `permissionMode` assignment |
| `acp-runtime-manager.ts` | 591-637 | `createClient` — ignores `permissionMode` from options |
| `acp-runtime-manager.ts` | 899-902 | `newSession` — no permission params |
| `acp-client-handler.ts` | 52-86 | `requestPermission` — no auto-approve for YOLO |
| `types.ts` | 10 | Dead `permissionMode` field definition |

---

## How Permissions Work Today (by provider)

### CODEX (partially working)

1. User sets admin preset to YOLO
2. New session created → `applyConfiguredPermissionPreset` called
3. Resolves YOLO to `execution_mode: '["never","danger-full-access"]'`
4. Calls `setConfigOption` on the Codex adapter
5. Adapter sets `session.defaults.approvalPolicy = "never"` and `sandboxPolicy = dangerFullAccess`
6. On `turn/start`, `approvalPolicy: "never"` is passed to Codex
7. Codex never calls `requestPermission` — tools execute without prompting

**Known issue:** On session resume, step 2 is skipped (gated by `providerSessionId` check), so the approval policy may revert to Codex defaults.

### CLAUDE (broken)

1. User sets admin preset to YOLO
2. New session created → `applyConfiguredPermissionPreset` called but returns immediately (not CODEX)
3. `claude-agent-acp` spawned with no permission configuration
4. Agent executes and calls `requestPermission` for every tool needing approval
5. `AcpClientHandler.requestPermission` forwards to WebSocket → user is prompted
6. User must manually approve every tool call despite YOLO setting

---

## ACP Protocol Constraints

The ACP SDK's `NewSessionRequest` and `LoadSessionRequest` types do not include permission-specific fields. Both accept only:
- `cwd: string`
- `mcpServers: Array<McpServer>`
- `_meta?: Record<string, unknown>` (extensibility)

The `SessionConfigOption` system with category `"permission"` is the mechanism CODEX uses (via `execution_mode`), but CLAUDE's `claude-agent-acp` does not expose an equivalent config option.

The `requestPermission` RPC is a server→client call (agent asks the client). The client can respond with any of the offered options. This means Factory Factory, as the ACP client, has full control over permission responses and can auto-approve without user interaction.

---

## Impact

- **All CLAUDE-provider sessions** ignore the global permission preset entirely
- **Resumed CODEX sessions** may revert to default (non-YOLO) behavior
- The `permissionMode` field on `AcpClientOptions` creates a false impression that permission bypass is wired up
- Users who set YOLO expect a hands-off experience but are interrupted by permission prompts on every tool call

---

## Recommended Fix

A layered approach that combines agent-side configuration (when available) with a universal client-side fallback.

### Layer 1: Generalize `applyConfiguredPermissionPreset` for all providers

Remove the CODEX-only guard and attempt to apply the permission preset to any provider that exposes a permission-category config option.

**Location:** `src/backend/domains/session/lifecycle/session.config.service.ts:152`

**Current:**
```typescript
if (handle.provider !== 'CODEX') {
  return;
}
```

**Proposed:** Remove the provider check entirely. The method already guards on `executionModeOption` existence (line 156-161), so if a provider doesn't expose a permission config option, the method no-ops naturally:

```typescript
const executionModeOption = handle.configOptions.find(
  (option) => option.id === 'execution_mode' || option.category === 'permission'
);
if (!executionModeOption) {
  return; // Provider doesn't support permission config — fall through to Layer 2
}
```

If `claude-agent-acp` exposes an `execution_mode` or permission-category config option from `newSession`, this change enables it automatically. If it doesn't (current behavior), the method still no-ops and Layer 2 handles it.

**Also fix the resume gate** in `session.lifecycle.service.ts` at lines 135, 249, and 262. The `providerSessionId` check should not prevent re-applying the preset, since the adapter may have reset its internal state on resume. Either remove the gate or always re-apply.

### Layer 2: Client-side auto-approve in `AcpClientHandler`

Add preset-aware auto-approval to `AcpClientHandler.requestPermission()`. This is the universal fallback that works regardless of what the ACP adapter supports.

**Location:** `src/backend/domains/session/acp/acp-client-handler.ts`

**Proposed change:** Accept an auto-approve policy at construction time and check it before forwarding to the permission bridge:

```typescript
export class AcpClientHandler implements Client {
  private readonly sessionId: string;
  private readonly onEvent: AcpEventCallback;
  private readonly permissionBridge: AcpPermissionBridge | null;
  private readonly onLog: AcpLogCallback | null;
  private readonly autoApprovePolicy: 'none' | 'all';

  constructor(
    sessionId: string,
    onEvent: AcpEventCallback,
    permissionBridge?: AcpPermissionBridge,
    onLog?: AcpLogCallback,
    autoApprovePolicy?: 'none' | 'all'
  ) {
    // ...
    this.autoApprovePolicy = autoApprovePolicy ?? 'none';
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.onLog?.(this.sessionId, {
      eventType: 'acp_permission_request',
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
    });

    // Auto-approve when configured (YOLO mode)
    if (this.autoApprovePolicy === 'all') {
      const allowOption = params.options.find(
        (o) => o.kind === 'allow_always' || o.kind === 'allow_once'
      );
      return Promise.resolve({
        outcome: {
          outcome: 'selected',
          optionId: allowOption?.optionId ?? params.options[0]?.optionId ?? 'unknown',
        },
      });
    }

    if (!this.permissionBridge) {
      // Fail closed when bridge is missing
      // ...
    }

    // Existing bridge flow
    // ...
  }
}
```

The `autoApprovePolicy` value is determined at client creation time by reading the user's configured permission preset. This happens in `acp-runtime-manager.ts` when constructing the `AcpClientHandler`:

```typescript
// In createClient(), when building the AcpClientHandler:
const autoApprovePolicy = resolveAutoApprovePolicy(options.permissionPreset);

const connection = new ClientSideConnection(
  (_agent) =>
    new AcpClientHandler(sessionId, onEvent, handlers.permissionBridge, handlers.onAcpLog, autoApprovePolicy),
  stream
);
```

This gives the `permissionMode` field on `AcpClientOptions` a purpose (replacing the dead `permissionMode: 'bypassPermissions'` assignment) and threads the user's preference all the way to the handler.

### RELAXED mode handling

For the RELAXED preset (`approvalPolicy: "on-failure"`), the client-side auto-approve approach needs nuance. RELAXED means "only ask when something fails," but at the `requestPermission` layer, Factory Factory doesn't have visibility into whether the request is triggered by a failure or a proactive check.

Two options:
1. **Treat RELAXED as STRICT at the client layer** — rely on agent-side config (Layer 1) for RELAXED behavior, fall back to prompting if the agent still asks.
2. **Auto-approve on RELAXED too** — since the agent is already configured to only ask on failure (if Layer 1 applied), any remaining `requestPermission` calls from a misconfigured/resumed session are safe to auto-approve.

Option 2 is simpler and matches user intent: if they chose RELAXED, they want minimal interruption.

### Cleanup: Remove dead code

- Remove the `permissionMode` field from `AcpClientOptions` (`types.ts:10`) and replace it with a `permissionPreset` field typed as `SessionPermissionPreset` to carry the user's configured preference.
- Remove the `SessionPermissionMode` type (`'bypassPermissions' | 'plan'`) if it's no longer used after the refactor.
- Update `session.lifecycle.service.ts:456` to pass the resolved permission preset instead of the unused `permissionMode`.

---

## Implementation Plan

### Phase 1: Client-side auto-approve (fixes CLAUDE sessions)

1. Add `permissionPreset` to `AcpClientOptions`, replacing dead `permissionMode` field.
2. Thread the user's `defaultWorkspacePermissions` (or `ratchetPermissions` for ratchet workflows) through to `createClient` → `AcpClientHandler`.
3. In `AcpClientHandler.requestPermission()`, auto-approve when preset is YOLO (or RELAXED, per decision above).
4. Update `acp-runtime-manager.ts` to pass the preset when constructing `AcpClientHandler`.

### Phase 2: Generalize agent-side config (opportunistic)

5. Remove the `provider !== 'CODEX'` guard in `applyConfiguredPermissionPreset`.
6. Remove the `providerSessionId` gate so presets are re-applied on session resume.
7. Verify behavior when `claude-agent-acp` doesn't expose `execution_mode` config (should no-op gracefully — existing guard on `executionModeOption` handles this).

### Phase 3: Cleanup

8. Remove dead `permissionMode` field and `SessionPermissionMode` type.
9. Add tests for the new auto-approve path in `AcpClientHandler`.
10. Add tests verifying `applyConfiguredPermissionPreset` is called on session resume.
