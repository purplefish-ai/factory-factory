---
phase: 22-cleanup-polish
plan: 02
subsystem: session
tags: [acp, dead-code-removal, config-cleanup, admin-reporting, barrel-rewrite]

# Dependency graph
requires:
  - phase: 22-cleanup-polish
    plan: 01
    provides: "SessionFileReader class at data/, ACP-only SessionService with deprecated stubs"
provides:
  - "claude/, codex/, providers/ directories fully deleted (~50 files, ~17K lines removed)"
  - "ACP-only barrel exports in session/index.ts and runtime/index.ts"
  - "Clean config with no CODEX_APP_SERVER or CLAUDE_HUNG env vars"
  - "Admin process reporting via acpRuntimeManager.getAllActiveProcesses()"
  - "AcpProcessHandle.provider field for process identification"
affects: ["22-03 (final barrel cleanup and deprecated stub removal)"]

# Tech tracking
tech-stack:
  added: []
  patterns: ["AcpRuntimeManager.getAllActiveProcesses() for admin reporting", "AcpProcessHandle carries provider field from creation options"]

key-files:
  created: []
  modified:
    - "src/backend/domains/session/index.ts"
    - "src/backend/domains/session/runtime/index.ts"
    - "src/backend/domains/session/acp/acp-runtime-manager.ts"
    - "src/backend/domains/session/acp/acp-process-handle.ts"
    - "src/backend/services/env-schemas.ts"
    - "src/backend/services/config.service.ts"
    - "src/backend/services/constants.ts"
    - "src/backend/trpc/admin.trpc.ts"
    - "src/client/routes/admin/ProcessesSection.tsx"
    - "src/backend/domains/session/chat/chat-event-forwarder.service.ts"
    - "src/backend/routers/websocket/chat.handler.ts"
    - "src/backend/agents/process-adapter.ts"

key-decisions:
  - "Replaced ClaudeJson type with ClaudeMessage from @/shared/claude instead of recreating the union type locally"
  - "Stubbed AgentProcessAdapter as deprecated no-op rather than deleting it, since server.ts imports it for shutdown cleanup"
  - "Added provider field to AcpProcessHandle constructor to avoid runtime lookups in admin reporting"
  - "Admin endpoint returns null for cpuPercent/memoryBytes/idleTimeMs since ACP handles don't expose resource monitoring"
  - "Removed codex section entirely from admin getActiveProcesses response (frontend never rendered it)"
  - "Kept codexCliVersionCheck timeout constant since cli-health.service.ts still uses it for health checks"

patterns-established:
  - "Admin process reporting uses acpRuntimeManager directly instead of legacy sessionService delegation"
  - "Session barrel exports SessionFileReader with backward-compat SessionManager alias"

# Metrics
duration: 15min
completed: 2026-02-14
---

# Phase 22 Plan 02: Delete Legacy Protocol Stacks, Clean Config, Update Admin Reporting Summary

**Deleted ~50 files (17K lines) of legacy Claude NDJSON, Codex app-server, and provider adapter code; cleaned all config knobs; rewired admin process reporting to ACP**

## Performance

- **Duration:** 15 min
- **Started:** 2026-02-14T00:16:21Z
- **Completed:** 2026-02-14T00:32:02Z
- **Tasks:** 2
- **Files modified:** 74

## Accomplishments
- Deleted entire claude/ (21 files), codex/ (17 files), providers/ (6 files) directories plus legacy runtime managers and process manager aliases
- All consumer imports updated: SessionManager -> SessionFileReader, ClaudeContentItem -> @/shared/claude, ClaudeJson -> ClaudeMessage
- ChatEventForwarderService stripped to workspace notifications and pending requests only (900+ lines of ClaudeClient event forwarding removed)
- Config cleaned: 6 Codex env vars, CLAUDE_HUNG_TIMEOUT_MS, and all associated config interfaces/builders/getters removed
- Admin process reporting now uses acpRuntimeManager.getAllActiveProcesses() instead of legacy sessionService stubs
- All 1905 tests pass, typecheck clean, dependency-cruiser clean, knip clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete legacy protocol stacks and fix all consumer imports** - `b8409340` (feat)
2. **Task 2: Clean config knobs and update admin process reporting** - `f520095b` (feat)

## Files Created/Modified
- `src/backend/domains/session/claude/` - DELETED (21 files, ~260KB)
- `src/backend/domains/session/codex/` - DELETED (17 files, ~70KB)
- `src/backend/domains/session/providers/` - DELETED (6 files)
- `src/backend/domains/session/runtime/claude-runtime-manager.ts` + test - DELETED
- `src/backend/domains/session/runtime/codex-app-server-manager.ts` + test - DELETED
- `src/backend/domains/session/lifecycle/session.process-manager.ts` + test - DELETED
- `src/backend/domains/session/session-domain-exports.test.ts` - DELETED
- `src/backend/domains/session/chat/chat-event-forwarder.service.test.ts` - DELETED
- `src/backend/lib/event-emitter-types.ts` - DELETED
- `src/backend/domains/session/index.ts` - Rewritten with ACP-only exports
- `src/backend/domains/session/runtime/index.ts` - Rewritten with ACP-only exports
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` - Stripped to pending requests + workspace notifications
- `src/backend/routers/websocket/chat.handler.ts` - Removed isClaudeClient guard and setupClientEvents
- `src/backend/agents/process-adapter.ts` - Stubbed as deprecated no-op
- `src/backend/domains/session/data/session-file-reader.ts` - Replaced ClaudeJson with ClaudeMessage
- `src/backend/domains/session/acp/acp-process-handle.ts` - Added provider field
- `src/backend/domains/session/acp/acp-runtime-manager.ts` - Added getAllActiveProcesses()
- `src/backend/services/env-schemas.ts` - Removed 7 legacy env vars
- `src/backend/services/config.service.ts` - Removed ClaudeProcessConfig, CodexAppServerConfig
- `src/backend/services/constants.ts` - Removed 3 legacy timeout constants
- `src/backend/trpc/admin.trpc.ts` - Rewired to use acpRuntimeManager
- `src/client/routes/admin/ProcessesSection.tsx` - Label updated to "Agent Sessions"
- `.dependency-cruiser.cjs` - Removed obsolete rules for deleted directories

## Decisions Made
- Replaced `ClaudeJson` with `ClaudeMessage` from `@/shared/claude` (same shape, already shared)
- Stubbed `AgentProcessAdapter` instead of deleting (server.ts still imports for shutdown)
- Added `provider` field to `AcpProcessHandle` constructor (avoids runtime lookup in admin reporting)
- Admin endpoint returns `null` for resource monitoring fields (ACP handles don't expose CPU/memory)
- Removed `codex` section from admin response entirely (frontend never rendered it)
- Kept `codexCliVersionCheck` constant (still used by cli-health.service.ts)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed AgentProcessAdapter importing deleted ClaudeClient**
- **Found during:** Task 1
- **Issue:** `src/backend/agents/process-adapter.ts` imported `ClaudeClient` from session barrel. With ClaudeClient deleted, the server.ts import chain would fail.
- **Fix:** Stubbed AgentProcessAdapter as deprecated no-op, removing all ClaudeClient dependencies
- **Files modified:** src/backend/agents/process-adapter.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** b8409340 (Task 1 commit)

**2. [Rule 3 - Blocking] Fixed session-file-reader importing from deleted claude/types**
- **Found during:** Task 1
- **Issue:** `data/session-file-reader.ts` and its test imported `ClaudeJson` from `../claude/types` which was deleted
- **Fix:** Replaced `ClaudeJson` with `ClaudeMessage` from `@/shared/claude` (same structural type)
- **Files modified:** session-file-reader.ts, session-file-reader.test.ts
- **Verification:** pnpm typecheck passes, tests pass
- **Committed in:** b8409340 (Task 1 commit)

**3. [Rule 3 - Blocking] Deleted chat-event-forwarder.service.test.ts and session-domain-exports.test.ts**
- **Found during:** Task 1
- **Issue:** Test files tested deleted functionality (setupClientEvents with MockClaudeClient, barrel exports of deleted classes)
- **Fix:** Deleted both test files entirely since the code they tested was removed
- **Files modified:** chat-event-forwarder.service.test.ts (deleted), session-domain-exports.test.ts (deleted)
- **Verification:** pnpm test passes (1905 tests)
- **Committed in:** b8409340 (Task 1 commit)

**4. [Rule 3 - Blocking] Updated chat.handler.test.ts expectations**
- **Found during:** Task 1
- **Issue:** Test expected `setOnClientCreated` and `setOnCodexTerminalTurn` to be called, but those calls were removed
- **Fix:** Removed the expectations and mock setup for deleted methods
- **Files modified:** chat.handler.test.ts
- **Verification:** pnpm test passes
- **Committed in:** b8409340 (Task 1 commit)

**5. [Rule 3 - Blocking] Deleted unused event-emitter-types.ts (knip)**
- **Found during:** Task 1 (pre-commit hook knip check)
- **Issue:** `src/backend/lib/event-emitter-types.ts` was only used by the deleted chat-event-forwarder
- **Fix:** Deleted the unused file
- **Files modified:** src/backend/lib/event-emitter-types.ts (deleted)
- **Verification:** knip passes
- **Committed in:** b8409340 (Task 1 commit)

**6. [Rule 1 - Bug] Fixed Biome async lint errors in AgentProcessAdapter**
- **Found during:** Task 1 (pre-commit hook biome check)
- **Issue:** `startAgent`, `stopAgent`, `sendToAgent` were marked async but had no await
- **Fix:** Removed async from stubs, changed return types to synchronous
- **Files modified:** src/backend/agents/process-adapter.ts
- **Verification:** biome check passes
- **Committed in:** b8409340 (Task 1 commit)

**7. [Rule 3 - Blocking] Cleaned dependency-cruiser rules for deleted directories**
- **Found during:** Task 1
- **Issue:** Dependency-cruiser config had rules referencing providers/, codex/, claude/ paths that no longer exist
- **Fix:** Removed session-provider-import-boundary, session-codex-import-boundary, and non-session-modules-cannot-import-provider-runtime-internals rules
- **Files modified:** .dependency-cruiser.cjs
- **Verification:** deps:check passes with 0 violations
- **Committed in:** b8409340 (Task 1 commit)

---

**Total deviations:** 7 auto-fixed (1 bug, 6 blocking)
**Impact on plan:** All auto-fixes necessary for compilation and test correctness. The plan focused on the session domain files but several external consumers also referenced deleted modules (AgentProcessAdapter, session-file-reader test, chat handler test, dependency-cruiser config).

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All legacy protocol stacks fully deleted -- no claude/, codex/, providers/ directories remain
- Session barrel exports only ACP-related types and services
- Deprecated stubs in session.service.ts (getClient, setOnClientCreated, etc.) are still present -- Plan 03 should remove them
- Admin reporting uses ACP data -- no legacy process monitoring paths remain
- Ready for Plan 03 final cleanup

## Self-Check: PASSED

- All 7 key modified files exist at expected paths
- All 3 deleted directories confirmed absent (claude/, codex/, providers/)
- Both task commits (b8409340, f520095b) found in git log
- session/index.ts contains AcpRuntimeManager export
- No CODEX_APP_SERVER references remain in src/backend/
- 1905 tests pass, typecheck clean, dependency-cruiser clean, knip clean
</content>
</invoke>