---
phase: 02-session-domain-consolidation
plan: 02
subsystem: api
tags: [refactor, move-and-shim, claude-cli, process-registry, barrel-file]

# Dependency graph
requires:
  - phase: 02-01
    provides: protocol, types, registry, constants moved to domains/session/claude/
provides:
  - All claude/ source files at domains/session/claude/ with co-located tests
  - ClaudeClient renamed to client.ts at new location
  - Claude subdirectory barrel file (index.ts) with selective public API
  - Re-export shims at all old src/backend/claude/ paths
  - processRegistry singleton shared between old and new consumers
affects: [02-04, 02-05, 02-06, 08-orchestration, 09-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [move-and-shim with shared singleton, selective barrel re-exports, knip ignore for shim directories]

key-files:
  created:
    - src/backend/domains/session/claude/client.ts
    - src/backend/domains/session/claude/index.ts
    - src/backend/domains/session/claude/monitoring.ts
    - src/backend/domains/session/claude/process.ts
    - src/backend/domains/session/claude/permissions.ts
    - src/backend/domains/session/claude/permission-coordinator.ts
    - src/backend/domains/session/claude/session.ts
    - src/backend/domains/session/claude/process.test.ts
    - src/backend/domains/session/claude/permissions.test.ts
    - src/backend/domains/session/claude/permission-coordinator.test.ts
    - src/backend/domains/session/claude/session.test.ts
  modified:
    - src/backend/domains/session/claude/registry.ts
    - src/backend/claude/index.ts
    - src/backend/claude/process.ts
    - src/backend/claude/monitoring.ts
    - src/backend/claude/permissions.ts
    - src/backend/claude/permission-coordinator.ts
    - src/backend/claude/session.ts
    - src/backend/claude/registry.ts
    - knip.json

key-decisions:
  - "processRegistry singleton in registry.ts ensures old free-function API and new class API share same Map"
  - "Barrel uses selective exports (not blanket export *) to avoid circular dependency issues"
  - "Old index.ts shim uses individual module paths (not barrel) to prevent double-barrel chains"
  - "Knip ignore added for src/backend/claude/ shim directory and subdirectory barrel files"

patterns-established:
  - "Shared singleton pattern: export const processRegistry for intra-module use, shim delegates to same instance"
  - "Selective barrel: named exports per module rather than wildcard re-exports"

# Metrics
duration: 9min
completed: 2026-02-10
---

# Phase 02 Plan 02: Claude File Migration Summary

**Full migration of process, monitoring, permissions, session, and ClaudeClient to domains/session/claude/ with selective barrel file and shared processRegistry singleton**

## Performance

- **Duration:** 9 min
- **Started:** 2026-02-10T12:36:13Z
- **Completed:** 2026-02-10T12:45:35Z
- **Tasks:** 2
- **Files modified:** 20

## Accomplishments
- Moved all 5 remaining claude/ source files (process, monitoring, permissions, permission-coordinator, session) to domains/session/claude/
- Created ClaudeClient at client.ts (renamed from index.ts) with clean imports
- Built selective barrel index.ts with explicit named exports for the claude subdirectory public API
- All old paths replaced with @deprecated re-export shims for backward compatibility
- processRegistry singleton shared between old free-function consumers and new class consumers

## Task Commits

Each task was committed atomically:

1. **Task 1: Move process, monitoring, permissions, permission-coordinator, session** - `ae0668d` (feat)
2. **Task 2: Move ClaudeClient to client.ts and create barrel** - `e938a86` (feat)

## Files Created/Modified
- `src/backend/domains/session/claude/client.ts` - ClaudeClient high-level API (moved from old index.ts)
- `src/backend/domains/session/claude/index.ts` - Selective barrel file for claude subdirectory
- `src/backend/domains/session/claude/process.ts` - ClaudeProcess lifecycle management
- `src/backend/domains/session/claude/monitoring.ts` - Resource monitoring for CLI processes
- `src/backend/domains/session/claude/permissions.ts` - Permission handlers (auto-approve, mode-based, deferred)
- `src/backend/domains/session/claude/permission-coordinator.ts` - Protocol/permission bridge
- `src/backend/domains/session/claude/session.ts` - JSONL session history reader
- `src/backend/domains/session/claude/registry.ts` - Added processRegistry singleton export
- `src/backend/claude/index.ts` - Re-export shim (individual module paths, not barrel)
- `src/backend/claude/process.ts` - Re-export shim
- `src/backend/claude/monitoring.ts` - Re-export shim
- `src/backend/claude/permissions.ts` - Re-export shim
- `src/backend/claude/permission-coordinator.ts` - Re-export shim
- `src/backend/claude/session.ts` - Re-export shim
- `src/backend/claude/registry.ts` - Updated to use shared processRegistry singleton
- `knip.json` - Added ignore patterns for shim directory and subdirectory barrels

## Decisions Made
- **processRegistry singleton**: Added `export const processRegistry = new ProcessRegistry()` to registry.ts and updated old registry.ts shim to use the same instance. This ensures both old free-function callers (registerProcess/unregisterProcess) and new class consumers share the same underlying Map.
- **Selective barrel exports**: index.ts uses explicit named exports per module rather than blanket `export *` to avoid circular dependency issues (per research pitfall 1).
- **Individual module paths in shim**: Old index.ts re-exports from each individual module path (not from the barrel) to prevent double-barrel re-export chains.
- **Knip ignore patterns**: Added `src/backend/claude/*.ts` and `src/backend/domains/**/*/index.ts` to knip ignore for re-export shims and subdirectory barrel files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed processRegistry singleton sharing**
- **Found during:** Task 1
- **Issue:** Old registry.ts shim created its own `new ProcessRegistry()` instance while new process.ts imported `processRegistry` from new registry.ts -- two separate Map instances would cause registration/lookup to fail
- **Fix:** Updated old registry.ts shim to import and use `processRegistry` from the new location instead of creating a private instance
- **Files modified:** src/backend/claude/registry.ts, src/backend/domains/session/claude/registry.ts
- **Verification:** pnpm typecheck passes, tests pass at both locations
- **Committed in:** ae0668d (Task 1 commit)

**2. [Rule 3 - Blocking] Added knip ignore for shim directories and subdirectory barrels**
- **Found during:** Task 1 and Task 2
- **Issue:** Knip reported re-export shim files and subdirectory barrel as unused (they are only imported indirectly)
- **Fix:** Added `src/backend/claude/*.ts`, `src/backend/claude/**/*.ts`, and `src/backend/domains/**/*/index.ts` to knip.json ignore
- **Files modified:** knip.json
- **Verification:** knip passes with no unused file warnings
- **Committed in:** ae0668d (Task 1), e938a86 (Task 2)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None - plan executed smoothly after addressing the singleton sharing issue.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete claude/ directory is now migrated to domains/session/claude/
- src/backend/claude/ contains only re-export shims (no business logic)
- Plans 04-06 can proceed with session-domain.service.ts, SessionProcessManager, and clean-up
- Phase 9 import rewiring will remove all shims

---
*Phase: 02-session-domain-consolidation*
*Completed: 2026-02-10*
