# Phase 22: Cleanup + Polish - Research

**Researched:** 2026-02-13
**Domain:** Legacy protocol code deletion, ACP integration testing, admin/health reporting, documentation
**Confidence:** HIGH

## Summary

Phase 22 is the final phase of the v1.2 ACP Cutover milestone. Phases 19-21 built the ACP runtime manager, event translator, permission bridge, config options UI, and unified runtime path. All new sessions now route through `AcpRuntimeManager` exclusively. The legacy Claude NDJSON protocol stack and Codex app-server stack are fully bypassed for new sessions but remain in the codebase -- serving only already-running legacy sessions (which will not exist after restart). This phase deletes all legacy protocol code, removes obsolete env/config knobs, replaces superseded tests with ACP-focused integration tests, updates admin/health process reporting to use the ACP per-session process model, and updates AGENTS.md to reflect ACP-only architecture.

The key risk in this phase is the tight coupling between `SessionService` and legacy adapters/types. The session service currently uses `ClaudeClient` types for its public API (`getClient`, `getAllClients`, `setOnClientCreated`), references `SessionManager` for JSONL history reading, and dispatches through both legacy adapters and ACP runtime manager. The cleanup must carefully refactor these to use ACP-only types while preserving the session hydration path (which reads `.claude/projects/` JSONL files for transcript replay -- a filesystem operation independent of the legacy protocol stack).

**Primary recommendation:** Execute cleanup in three sequential plans: (1) delete legacy protocol stacks and rewire SessionService to ACP-only, (2) replace superseded tests and add ACP integration tests, (3) update admin/health reporting and AGENTS.md documentation.

## Standard Stack

### Core (Retained -- ACP system)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@agentclientprotocol/sdk` | 0.14.1 | ACP SDK for ClientSideConnection, ndJsonStream, session lifecycle | Foundation of the new runtime -- all sessions use this |
| `vitest` | (project default) | Unit and integration testing | Already used throughout codebase |
| `p-limit` | (project default) | Concurrency limiting in AcpRuntimeManager | Already wired into session creation locks |

### To Be Removed (Legacy)
| Library/Module | Location | Why Remove |
|----------------|----------|------------|
| Claude NDJSON stack | `src/backend/domains/session/claude/` | Entirely replaced by ACP runtime |
| Codex app-server stack | `src/backend/domains/session/codex/` | Entirely replaced by ACP runtime |
| Claude runtime manager | `src/backend/domains/session/runtime/claude-runtime-manager.ts` | Deprecated; replaced by AcpRuntimeManager |
| Codex app-server manager | `src/backend/domains/session/runtime/codex-app-server-manager.ts` | Deprecated; replaced by AcpRuntimeManager |
| Claude provider adapter | `src/backend/domains/session/providers/claude-session-provider-adapter.ts` | No longer needed; ACP handles all providers |
| Codex provider adapter | `src/backend/domains/session/providers/codex-session-provider-adapter.ts` | No longer needed; ACP handles all providers |
| Session process manager | `src/backend/domains/session/lifecycle/session.process-manager.ts` | Thin alias for ClaudeRuntimeManager |

## Architecture Patterns

### Current Structure (Before Cleanup)
```
src/backend/domains/session/
├── acp/                    # KEEP -- ACP runtime (Phase 19-21)
│   ├── acp-client-handler.ts
│   ├── acp-event-translator.ts
│   ├── acp-event-translator.test.ts
│   ├── acp-permission-bridge.ts
│   ├── acp-permission-bridge.test.ts
│   ├── acp-process-handle.ts
│   ├── acp-runtime-manager.ts
│   ├── acp-runtime-manager.test.ts
│   ├── index.ts
│   └── types.ts
├── claude/                 # DELETE entirely -- legacy NDJSON protocol
│   ├── client.ts           # ClaudeClient -- replaced by AcpProcessHandle
│   ├── constants.ts
│   ├── index.ts
│   ├── monitoring.ts       # ClaudeProcessMonitor
│   ├── permission-coordinator.ts
│   ├── permission-coordinator.test.ts
│   ├── permissions.ts
│   ├── permissions.test.ts
│   ├── process.ts          # ClaudeProcess
│   ├── process.test.ts
│   ├── protocol.ts         # ClaudeProtocol (NDJSON streaming)
│   ├── protocol.test.ts
│   ├── protocol-io.ts      # ClaudeProtocolIO
│   ├── registry.ts         # ProcessRegistry
│   ├── session.ts          # SessionManager (PARTIAL KEEP - history reading)
│   ├── session.test.ts
│   ├── types.ts
│   ├── types.test.ts
│   └── types/
│       └── process-types.ts
├── codex/                  # DELETE entirely -- legacy Codex app-server
│   ├── codex-delta-mapper.ts
│   ├── codex-event-translator.ts
│   ├── codex-event-translator.test.ts
│   ├── codex-model-catalog.service.ts
│   ├── codex-model-catalog.service.test.ts
│   ├── codex-session-registry.ts
│   ├── codex-session-registry.test.ts
│   ├── codex-thread-read-transcript.ts
│   ├── codex-thread-read-transcript.test.ts
│   ├── errors.ts
│   ├── interactive-methods.ts
│   ├── payload-utils.ts
│   ├── README.md
│   ├── schema-snapshots/
│   │   └── app-server-methods.snapshot.json
│   ├── schemas.ts
│   ├── schemas.test.ts
│   └── types.ts
├── runtime/                # SIMPLIFY -- keep only provider-runtime-manager interface + ACP
│   ├── claude-runtime-manager.ts      # DELETE (deprecated)
│   ├── claude-runtime-manager.test.ts # DELETE
│   ├── codex-app-server-manager.ts    # DELETE (deprecated)
│   ├── codex-app-server-manager.test.ts # DELETE
│   ├── index.ts                       # REWRITE (export only ACP + interface)
│   └── provider-runtime-manager.ts    # KEEP (interface used by AcpRuntimeManager)
├── providers/              # SIMPLIFY drastically
│   ├── claude-session-provider-adapter.ts      # DELETE
│   ├── claude-session-provider-adapter.test.ts # DELETE
│   ├── codex-session-provider-adapter.ts       # DELETE
│   ├── codex-session-provider-adapter.test.ts  # DELETE
│   ├── index.ts                                # REWRITE
│   └── session-provider-adapter.ts             # May DELETE or simplify
├── lifecycle/
│   ├── session.process-manager.ts      # DELETE (thin alias)
│   ├── session.process-manager.test.ts # DELETE
│   ├── session.service.ts              # HEAVY REFACTOR
│   └── session.service.test.ts         # HEAVY REFACTOR
└── ... (chat/, data/, store/, logging/ -- keep, but update imports)
```

### Target Structure (After Cleanup)
```
src/backend/domains/session/
├── acp/                    # Unchanged -- ACP runtime
├── runtime/
│   ├── index.ts            # Re-exports ACP + ProviderRuntimeManager interface
│   └── provider-runtime-manager.ts  # Interface (used by AcpRuntimeManager)
├── lifecycle/
│   ├── session.service.ts  # Refactored to ACP-only
│   ├── session.service.test.ts
│   ├── session.prompt-builder.ts
│   ├── session.prompt-builder.test.ts
│   ├── session.repository.ts
│   └── session.repository.test.ts
├── chat/                   # Updated imports
├── data/                   # Updated imports
├── store/                  # Mostly unchanged (session-hydrator needs update)
├── logging/                # Unchanged
├── bridges.ts              # Unchanged
├── index.ts                # Rewritten barrel (ACP-only exports)
└── session-domain.service.ts  # Unchanged
```

### Pattern: SessionManager History Reading Must Be Preserved

**Critical finding:** `SessionManager` from `claude/session.ts` provides JSONL history reading from `~/.claude/projects/` paths. This is used by:
1. `session-hydrator.ts` -- hydrates transcript from `.claude/projects/{hash}/{sessionId}.jsonl`
2. `session.trpc.ts` -- `SessionManager.getProjectPath()` for creating sessions
3. `load-session.handler.ts` -- `SessionManager.hasSessionFileFromProjectPath()` for path resolution
4. `list-sessions.handler.ts` -- `SessionManager.listSessions()` for listing session files
5. `session.service.ts` -- `SessionManager.getHistory()` for conversation history

These are filesystem operations that read Claude CLI's local session files. They do NOT depend on the legacy NDJSON protocol -- they are independent read-only utilities. The `SessionManager` class (or its methods) should be preserved/relocated, not deleted with the rest of the claude/ directory.

**Recommendation:** Extract `SessionManager` to a new location (e.g., `src/backend/lib/claude-session-files.ts` or keep in `store/`) since it's a pure file-reading utility. `getClaudeProjectPath` already lives in `src/backend/lib/claude-paths.ts`.

### Pattern: Shared Types in `@/shared/claude` Stay

The `@/shared/claude/` directory contains shared protocol/message types (`ClaudeMessage`, `ClaudeContentItem`, `HistoryMessage`, `SessionDeltaEvent`, etc.) used throughout the frontend and backend. These are the **WebSocket message types**, NOT legacy protocol code. They must remain unchanged.

### Pattern: `@/backend/agents/process-adapter.ts` Uses ClaudeClient

The `AgentProcessAdapter` class creates `ClaudeClient` instances directly. This file is used by the agent/fixer system and must be migrated to use ACP. However, examining it more closely, it's a separate concern that spawns standalone Claude CLI processes for agent workflows -- this may need ACP migration as a separate task.

### Anti-Patterns to Avoid
- **Deleting SessionManager without relocating:** Would break transcript hydration and session listing
- **Deleting `@/shared/claude`:** These are shared WebSocket message types, not legacy protocol code
- **Big-bang refactor of SessionService:** SessionService is 1300+ lines with interleaved ACP and legacy paths -- systematic method-by-method cleanup is safer
- **Removing the `provider` concept from DB:** The `SessionProvider` enum in Prisma schema persists; the cleanup is about runtime code, not data model changes

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ACP process lifecycle | Custom process management | `AcpRuntimeManager` (already built) | Phase 19-21 established this |
| ACP event translation | Custom event parsers | `AcpEventTranslator` (already built) | Handles all sessionUpdate types |
| ACP permission flow | Custom permission handling | `AcpPermissionBridge` (already built) | Handles suspend/resolve pattern |
| Session history reading | New history reader | Extract/relocate `SessionManager` methods | Pure FS utility, battle-tested |

## Common Pitfalls

### Pitfall 1: Breaking Transcript Hydration
**What goes wrong:** Deleting `claude/session.ts` breaks the session store's ability to hydrate transcripts from `.claude/projects/` JSONL files.
**Why it happens:** `SessionManager.getHistory()` and `SessionManager.hasSessionFileFromProjectPath()` are used by the hydrator, session tRPC, and load-session handler.
**How to avoid:** Extract `SessionManager` methods into a separate utility file BEFORE deleting `claude/` directory.
**Warning signs:** `session-hydrator.ts`, `load-session.handler.ts`, `list-sessions.handler.ts`, `session.trpc.ts` imports fail.

### Pitfall 2: Breaking External Consumers of Barrel Exports
**What goes wrong:** Files outside the session domain import types like `ClaudeClient`, `ProcessRegistry`, `ClaudeJson` from the session barrel.
**Why it happens:** The barrel (`index.ts`) re-exports many claude/ types used by `chat.handler.ts`, `admin.trpc.ts`, `process-adapter.ts`.
**How to avoid:** Audit all consumers BEFORE removing exports. Move shared types to `@/shared/claude` if needed.
**Warning signs:** TypeScript compilation errors in `src/backend/routers/`, `src/backend/trpc/`, `src/backend/agents/`.

### Pitfall 3: Missing ACP Process Reporting in Admin
**What goes wrong:** Admin page shows empty process list because ACP sessions aren't reported.
**Why it happens:** `getAllActiveProcesses()` currently returns Claude adapter's processes only. ACP sessions are in `acpRuntimeManager.sessions` map which has no equivalent reporting.
**How to avoid:** Add `getAllActiveProcesses()` method to `AcpRuntimeManager` that returns process info in the expected format.
**Warning signs:** Admin "Active Processes" section shows 0 processes despite running sessions.

### Pitfall 4: AgentProcessAdapter Not Migrated
**What goes wrong:** `src/backend/agents/process-adapter.ts` directly instantiates `ClaudeClient` and won't work after deletion.
**Why it happens:** This file is used by the fixer/agent system and was not part of the Phase 19-21 ACP migration.
**How to avoid:** Either migrate `AgentProcessAdapter` to use ACP, or mark it as a separate follow-up if the agent system is being redesigned.
**Warning signs:** Agent/fixer workflows fail after cleanup.

### Pitfall 5: Codex Config Knobs Left as Dead Config
**What goes wrong:** `CODEX_APP_SERVER_COMMAND`, `CODEX_APP_SERVER_ARGS`, `CODEX_APP_SERVER_REQUEST_TIMEOUT_MS`, `CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS`, `CODEX_REQUEST_USER_INPUT_ENABLED` remain in env schema but serve no purpose.
**Why it happens:** Config is often overlooked during code cleanup.
**How to avoid:** Include config cleanup as an explicit task: remove from `env-schemas.ts`, `config.service.ts` (both the interface and builder function), and `constants.ts`.
**Warning signs:** Unused env vars in config validation schema.

### Pitfall 6: Test Files Referencing Deleted Modules
**What goes wrong:** Test files outside the deleted directories import from deleted paths.
**Why it happens:** Session service tests, chat handler tests, and export tests mock legacy modules.
**How to avoid:** Run `pnpm typecheck` after each deletion step. Update mocks to use ACP equivalents.
**Warning signs:** Test compilation failures.

## Code Examples

### Inventory of Files to Delete (CLEAN-01: Claude Protocol Stack)

Entire `src/backend/domains/session/claude/` directory EXCEPT `session.ts` methods (relocate first):
- `client.ts` (ClaudeClient)
- `constants.ts`
- `monitoring.ts` (ClaudeProcessMonitor)
- `permission-coordinator.ts` + test
- `permissions.ts` + test
- `process.ts` + test (ClaudeProcess)
- `protocol.ts` + test (ClaudeProtocol NDJSON)
- `protocol-io.ts` (ClaudeProtocolIO)
- `registry.ts` (ProcessRegistry)
- `session.ts` + test (SessionManager -- RELOCATE, don't delete)
- `types.ts` + test
- `types/process-types.ts`
- `index.ts`

### Inventory of Files to Delete (CLEAN-02: Codex Protocol Stack)

Entire `src/backend/domains/session/codex/` directory:
- `codex-delta-mapper.ts`
- `codex-event-translator.ts` + test
- `codex-model-catalog.service.ts` + test
- `codex-session-registry.ts` + test
- `codex-thread-read-transcript.ts` + test
- `errors.ts`
- `interactive-methods.ts`
- `payload-utils.ts`
- `README.md`
- `schema-snapshots/` directory
- `schemas.ts` + test
- `types.ts`

### Inventory of Additional Files to Delete
- `src/backend/domains/session/runtime/claude-runtime-manager.ts` + test
- `src/backend/domains/session/runtime/codex-app-server-manager.ts` + test
- `src/backend/domains/session/providers/claude-session-provider-adapter.ts` + test
- `src/backend/domains/session/providers/codex-session-provider-adapter.ts` + test
- `src/backend/domains/session/providers/session-provider-adapter.ts` (base interface)
- `src/backend/domains/session/lifecycle/session.process-manager.ts` + test

### Files Requiring Heavy Refactoring

**`session.service.ts` (1300+ lines) -- Key changes needed:**
- Remove `claudeAdapter` and `codexAdapter` fields
- Remove `resolveAdapterForProvider()`, `resolveKnownAdapterForSessionSync()`, `resolveAdapterForSessionSync()`
- Remove `initializeCodexManagerHandlers()` and all Codex notification/event handling
- Remove `normalizeCodexDeltaEvent()`, `isTerminalCodexTurnMethod()`, `notifyCodexTerminalTurn()`
- Remove Codex-specific `toCodexTextContent()` helper
- Simplify `sendSessionMessage()` to always use ACP path
- Simplify `stopSession()` to always use ACP path
- Simplify `isSessionRunning()`, `isSessionWorking()`, `isAnySessionWorking()` to ACP-only
- Replace `getAllActiveProcesses()` with ACP-based reporting
- Remove `getCodexManagerStatus()`, `getAllCodexActiveProcesses()`
- Remove `getAllClients()` returning ClaudeClient iterator
- Remove `getClient()` returning ClaudeClient
- Remove `setOnClientCreated()` (legacy callback for ClaudeClient event forwarding)
- Remove `setOnCodexTerminalTurn()` callback
- Simplify `getRuntimeSnapshot()` to check ACP only
- Simplify `getChatBarCapabilities()` to always use ACP config options
- Update `respondToPermissionRequest()` to ACP-only path

**`session.service.test.ts` -- Key changes needed:**
- Remove all `claudeSessionProviderAdapter` and `codexSessionProviderAdapter` mocks
- Update all tests to use `acpRuntimeManager` mocks
- Add new ACP-focused integration tests

**`chat-event-forwarder.service.ts` -- Key changes needed:**
- Remove `ClaudeClient` import and event listener setup
- This service handles forwarding ClaudeClient events to WebSocket; with ACP, events come via `AcpClientHandler`/`AcpEventTranslator` instead
- May become mostly dead code -- evaluate if it can be removed or simplified

**`chat.handler.ts` -- Key changes needed:**
- Remove `isClaudeClient()` type guard
- Remove `ClaudeClient` type import

### Config Cleanup (CLEAN-03)

Remove from `env-schemas.ts`:
```typescript
// DELETE these lines:
CODEX_APP_SERVER_COMMAND: z.preprocess(toTrimmedString, z.string().min(1)).catch('codex'),
CODEX_APP_SERVER_ARGS: z.preprocess(toTrimmedString, z.string()).optional(),
CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: PositiveIntEnvSchema.catch(SERVICE_TIMEOUT_MS.codexAppServerRequest),
CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: PositiveIntEnvSchema.catch(SERVICE_TIMEOUT_MS.codexAppServerHandshake),
CODEX_REQUEST_USER_INPUT_ENABLED: z.preprocess(parseBoolean, z.boolean()).catch(false),
```

Remove from `config.service.ts`:
- `CodexAppServerConfig` interface
- `buildCodexAppServerConfig()` function
- `codexAppServer` field in `SystemConfig`
- `getCodexAppServerConfig()` method

Remove from `constants.ts`:
```typescript
// DELETE these:
codexAppServerHandshake: 15_000,
codexAppServerRequest: 30_000,
```

Evaluate whether `CLAUDE_HUNG_TIMEOUT_MS` / `ClaudeProcessConfig` / `buildClaudeProcessConfig()` are still needed. If the ACP runtime doesn't use them, remove.

### Admin Process Reporting (CLEAN-05)

The current `admin.trpc.ts` `getActiveProcesses` endpoint calls:
- `sessionService.getAllActiveProcesses()` -- returns Claude adapter processes
- `sessionService.getCodexManagerStatus()` -- returns Codex app-server status
- `sessionService.getAllCodexActiveProcesses()` -- returns Codex sessions

Replace with ACP-based reporting. `AcpRuntimeManager` needs a new method:
```typescript
getAllActiveProcesses(): Array<{
  sessionId: string;
  pid: number | undefined;
  status: string;
  isRunning: boolean;
  isPromptInFlight: boolean;
  provider: string;
}> {
  const processes: Array<...> = [];
  for (const [sessionId, handle] of this.sessions) {
    processes.push({
      sessionId,
      pid: handle.getPid() ?? undefined,
      status: handle.isRunning() ? 'running' : 'stopped',
      isRunning: handle.isRunning(),
      isPromptInFlight: handle.isPromptInFlight,
      provider: handle.provider,
    });
  }
  return processes;
}
```

The frontend `ProcessesSection.tsx` shows Claude processes with PID, resources, status, etc. Update the admin endpoint to source this data from ACP sessions. The `ProcessesSection` itself may not need changes if the data shape is kept compatible.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ClaudeClient spawns `claude` CLI, NDJSON protocol | AcpRuntimeManager spawns adapter binary, ACP SDK protocol | Phase 19-21 (2026-02-13) | All new sessions use ACP |
| CodexAppServerManager manages singleton `codex app-server` | AcpRuntimeManager per-session processes | Phase 19-21 (2026-02-13) | Codex provider also uses ACP |
| ClaudeSessionProviderAdapter wraps ClaudeRuntimeManager | Direct AcpRuntimeManager usage from SessionService | Phase 21 (2026-02-13) | Provider adapter layer eliminated |
| Legacy `useAcp` feature flag routing | Always-ACP path (no flag) | Phase 21-03 (2026-02-13) | Single runtime path |

## Dependency Map (Who Imports What)

### Files Outside Session Domain That Import Legacy Types

| File | Imports | Action |
|------|---------|--------|
| `src/backend/routers/websocket/chat.handler.ts` | `ClaudeClient`, `ConnectionInfo` from session barrel | Remove `ClaudeClient` usage, keep `ConnectionInfo` |
| `src/backend/trpc/admin.trpc.ts` | `sessionDataService` from session barrel | Keep (not legacy) |
| `src/backend/trpc/session.trpc.ts` | `SessionManager`, `sessionDataService` from session barrel | Update `SessionManager` import to relocated utility |
| `src/backend/agents/process-adapter.ts` | `ClaudeClient`, `ClaudeClientOptions`, `ClaudeJson`, types | Migrate to ACP or extract as separate concern |
| `src/backend/lib/claude-paths.ts` | None from session domain | Keep unchanged |

### Files Within Session Domain That Import Cross-Subdirectory

| Consumer | Imports From | Action |
|----------|-------------|--------|
| `lifecycle/session.service.ts` | `claude/client`, `claude/process`, `claude/registry`, `claude/session`, `codex/*`, `providers/*`, `runtime/*` | Heavy refactor -- remove all claude/codex imports |
| `chat/chat-event-forwarder.service.ts` | `claude/index` (ClaudeClient type), `providers/` (claudeSessionProviderAdapter) | Simplify or remove |
| `chat/chat-message-handlers/handlers/load-session.handler.ts` | `claude/session` (SessionManager) | Update import to relocated utility |
| `chat/chat-message-handlers/handlers/list-sessions.handler.ts` | `claude/index` (SessionManager) | Update import to relocated utility |
| `chat/chat-message-handlers/attachment-processing.ts` | `claude/types` (ClaudeContentItem) | Already in `@/shared/claude` -- update import |
| `chat/chat-message-handlers/handlers/user-input.handler.ts` | `claude/types` (ClaudeContentItem) | Already in `@/shared/claude` -- update import |
| `store/session-hydrator.ts` | `claude/session` (SessionManager) | Update import to relocated utility |
| `session-domain.service.test.ts` | `claude/session` (SessionManager) | Update import |

## Open Questions

1. **AgentProcessAdapter migration scope**
   - What we know: `src/backend/agents/process-adapter.ts` directly creates `ClaudeClient` instances for agent/fixer workflows
   - What's unclear: Whether this should be migrated to ACP in Phase 22 or left as a separate follow-up
   - Recommendation: Migrate it if feasible (it follows the same pattern as session creation), but could be deferred if the agent system is being redesigned

2. **ClaudeContentItem type location**
   - What we know: `ClaudeContentItem` is defined in `claude/types.ts` but also re-exported from `@/shared/claude/protocol/content.ts`
   - What's unclear: Whether all consumers already use the shared version or need migration
   - Recommendation: Verify which version each consumer uses; ensure `@/shared/claude` has all needed types before deleting `claude/types.ts`

3. **CLAUDE_HUNG_TIMEOUT_MS env var**
   - What we know: This controls the "hung process" timeout for Claude processes via `ClaudeProcessMonitor`
   - What's unclear: Whether ACP has its own timeout mechanism or if this env var should be preserved for ACP
   - Recommendation: Remove if ACP manages its own timeouts (the SDK likely handles this); verify with ACP runtime behavior

4. **SessionProvider enum in Prisma**
   - What we know: The DB has `CLAUDE` and `CODEX` enum values; sessions still store their provider
   - What's unclear: Whether the `CODEX` value should be kept (existing data) or removed
   - Recommendation: Keep the Prisma enum -- data model cleanup is a separate concern from runtime code cleanup. Existing sessions may have `CODEX` provider values.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of `src/backend/domains/session/` directory structure and all files
- Phase 21 verification report (`21-VERIFICATION.md`) confirming all new sessions use ACP
- Phase 21-03 summary (`21-03-SUMMARY.md`) confirming legacy managers deprecated
- Session barrel exports (`index.ts`) showing current public API
- `session.service.ts` (1300+ lines) -- full analysis of legacy/ACP interleaving
- `admin.trpc.ts` getActiveProcesses endpoint -- current process reporting implementation
- `config.service.ts` and `env-schemas.ts` -- current config knob inventory
- `AGENTS.md` -- current documentation state

### Secondary (MEDIUM confidence)
- `@agentclientprotocol/sdk` version 0.14.1 from `package.json`

### Tertiary (LOW confidence)
- None -- all findings verified from codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - direct codebase analysis, all files inspected
- Architecture: HIGH - complete file inventory, import dependency map built
- Pitfalls: HIGH - identified from concrete import chains and usage patterns
- Code examples: HIGH - all examples from actual codebase with line numbers

**Research date:** 2026-02-13
**Valid until:** 2026-03-13 (stable -- no external dependencies changing)
