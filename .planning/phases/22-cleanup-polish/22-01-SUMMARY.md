---
phase: 22-cleanup-polish
plan: 01
subsystem: session
tags: [acp, session-service, session-file-reader, refactoring, dead-code-removal]

# Dependency graph
requires:
  - phase: 21-config-options-unified-runtime
    provides: "AcpRuntimeManager as unified runtime, config options, buildAcpChatBarCapabilities"
provides:
  - "SessionFileReader class at data/session-file-reader.ts with all JSONL reading methods"
  - "ACP-only SessionService with zero legacy imports"
  - "Backward-compatible SessionManager alias for incremental migration"
  - "Deprecated stubs for consumer compatibility during bulk deletion"
affects: ["22-02 (bulk file deletion)", "22-03 (barrel cleanup)"]

# Tech tracking
tech-stack:
  added: []
  patterns: ["deprecated stub pattern for incremental migration", "type-narrowing casts for getClient returning unknown"]

key-files:
  created:
    - "src/backend/domains/session/data/session-file-reader.ts"
    - "src/backend/domains/session/data/session-file-reader.test.ts"
  modified:
    - "src/backend/domains/session/lifecycle/session.service.ts"
    - "src/backend/domains/session/lifecycle/session.service.test.ts"
    - "src/backend/domains/session/chat/chat-message-handlers/interactive-response.ts"
    - "src/backend/interceptors/conversation-rename.interceptor.ts"
    - "src/backend/orchestration/domain-bridges.orchestrator.ts"
    - "src/backend/routers/websocket/chat.handler.ts"

key-decisions:
  - "Kept deprecated stubs for 12 methods that have external consumers (getClient, setOnClientCreated, etc.) to maintain typecheck while allowing incremental migration in Plan 02"
  - "Changed getClient return type from ClaudeClient to unknown to avoid importing claude/ types"
  - "Made sendSessionMessage return Promise<void> via .then() instead of async to satisfy Biome lint and callers using .catch()"
  - "Made getChatBarCapabilities synchronous with default fallback instead of legacy adapter delegation"
  - "Used type casts in 4 consumer files to maintain compile compatibility with getClient returning unknown"

patterns-established:
  - "Deprecated stub pattern: methods marked @deprecated return no-ops/empty values while preserving API signatures"
  - "SessionFileReader as the canonical location for JSONL file reading, independent of claude/ directory"

# Metrics
duration: 16min
completed: 2026-02-13
---

# Phase 22 Plan 01: SessionManager Relocation + SessionService ACP-Only Refactor Summary

**SessionFileReader relocated from claude/ to data/, SessionService stripped of all legacy imports (claude/, codex/, providers/) with 12 deprecated stubs for incremental consumer migration**

## Performance

- **Duration:** 16 min
- **Started:** 2026-02-13T23:57:04Z
- **Completed:** 2026-02-14T00:13:18Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- SessionFileReader class created at `data/session-file-reader.ts` with all SessionManager static methods and backward-compatible alias
- SessionService reduced from 1425 lines to ~1020 lines with zero imports from claude/, codex/, providers/, or runtime/
- All 2352 tests pass, typecheck clean, dependency-cruiser clean, knip clean
- claude/ and codex/ directories are now fully dead code ready for deletion in Plan 02

## Task Commits

Each task was committed atomically:

1. **Task 1: Relocate SessionManager to session-file-reader.ts** - `1bb79c48` (feat)
2. **Task 2: Refactor SessionService to ACP-only** - `724da286` (refactor)

## Files Created/Modified
- `src/backend/domains/session/data/session-file-reader.ts` - SessionFileReader class with all JSONL reading methods relocated from claude/session.ts
- `src/backend/domains/session/data/session-file-reader.test.ts` - 46 tests covering all SessionFileReader methods
- `src/backend/domains/session/lifecycle/session.service.ts` - ACP-only service with deprecated stubs for backward compatibility
- `src/backend/domains/session/lifecycle/session.service.test.ts` - 21 ACP-only tests (removed all claude/codex adapter mocks)
- `src/backend/domains/session/chat/chat-message-handlers/interactive-response.ts` - Cast getClient to typed object
- `src/backend/interceptors/conversation-rename.interceptor.ts` - Cast getClient to sendMessage interface
- `src/backend/orchestration/domain-bridges.orchestrator.ts` - Cast getClient for RatchetSessionBridge
- `src/backend/routers/websocket/chat.handler.ts` - Guard setOnClientCreated with isClaudeClient type guard

## Decisions Made
- Kept 12 deprecated stub methods (getClient, setOnClientCreated, setOnCodexTerminalTurn, toPublicMessageDelta, tryHydrateCodexTranscript, rewindSessionFiles, getClaudeProcess, getAllActiveProcesses, getCodexManagerStatus, getAllCodexActiveProcesses, getAllClients, ClientCreatedCallback) because they have external callers that will be updated in Plan 02
- Changed getClient return type to `unknown` instead of `ClaudeClient` to avoid importing from claude/
- Made getChatBarCapabilities synchronous since it no longer needs to load adapter capabilities

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed consumer type errors for getClient returning unknown**
- **Found during:** Task 2 (SessionService refactoring)
- **Issue:** 4 files outside session.service.ts call getClient and expected ClaudeClient return type. Changing to unknown broke compilation.
- **Fix:** Added type casts in interactive-response.ts, conversation-rename.interceptor.ts, domain-bridges.orchestrator.ts, and isClaudeClient guard in chat.handler.ts
- **Files modified:** interactive-response.ts, conversation-rename.interceptor.ts, domain-bridges.orchestrator.ts, chat.handler.ts
- **Verification:** pnpm typecheck passes with zero errors
- **Committed in:** 724da286 (Task 2 commit)

**2. [Rule 3 - Blocking] Kept deprecated stubs for methods with external consumers**
- **Found during:** Task 2 (SessionService refactoring)
- **Issue:** Plan specified removing 12+ methods but they have callers in other files (admin.trpc.ts, chat.handler.ts, interactive-response.ts, etc.)
- **Fix:** Kept methods as deprecated no-op stubs returning empty/undefined values, preserving API signatures
- **Files modified:** session.service.ts
- **Verification:** pnpm typecheck and pnpm test both pass
- **Committed in:** 724da286 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed Biome lint errors for async functions without await**
- **Found during:** Task 2 (pre-commit hook)
- **Issue:** setSessionReasoningEffort, sendSessionMessage, getChatBarCapabilities, tryHydrateCodexTranscript, rewindSessionFiles were marked async but had no await
- **Fix:** Removed async from no-op stubs, converted sendSessionMessage to use .then() for Promise return, made getChatBarCapabilities synchronous
- **Files modified:** session.service.ts
- **Verification:** Biome check passes, callers using .catch() still work
- **Committed in:** 724da286 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All auto-fixes necessary for correctness. Deprecated stubs are the right approach for incremental migration -- Plan 02 will update consumers and remove the stubs.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- claude/ and codex/ directories are now dead code with zero imports from session.service.ts
- Plan 02 can safely delete claude/, codex/, providers/, and runtime/ directories
- Plan 03 can clean up the barrel file (index.ts) to remove legacy re-exports
- Deprecated stubs in session.service.ts should be removed in Plan 02 alongside consumer updates

## Self-Check: PASSED

- All 4 artifact files exist at expected paths
- Both task commits (1bb79c48, 724da286) found in git log
- session.service.ts is 1051 lines (plan required min_lines: 500)
- session-file-reader.ts contains SessionFileReader class
- session-file-reader.test.ts contains 46 tests
- Zero imports from claude/, codex/, providers/ in session.service.ts

---
*Phase: 22-cleanup-polish*
*Completed: 2026-02-13*
