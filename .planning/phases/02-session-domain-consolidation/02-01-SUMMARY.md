---
phase: 02-session-domain-consolidation
plan: 01
subsystem: api
tags: [typescript, domain-modules, refactoring, process-registry]

# Dependency graph
requires:
  - phase: 01-foundation-domain-scaffolding
    provides: domain directory structure with barrel files
provides:
  - Claude protocol types and Zod schemas at domains/session/claude/types.ts
  - NDJSON protocol handler at domains/session/claude/protocol.ts
  - Protocol IO adapter at domains/session/claude/protocol-io.ts
  - Process-types at domains/session/claude/types/process-types.ts
  - Constants at domains/session/claude/constants.ts
  - Instance-based ProcessRegistry class (DOM-04) at domains/session/claude/registry.ts
  - Re-export shims at all old claude/ paths for backward compatibility
affects: [02-session-domain-consolidation, 09-appcontext-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [move-and-shim, instance-based-registry]

key-files:
  created:
    - src/backend/domains/session/claude/types.ts
    - src/backend/domains/session/claude/types/process-types.ts
    - src/backend/domains/session/claude/constants.ts
    - src/backend/domains/session/claude/protocol.ts
    - src/backend/domains/session/claude/protocol-io.ts
    - src/backend/domains/session/claude/protocol.test.ts
    - src/backend/domains/session/claude/types.test.ts
    - src/backend/domains/session/claude/registry.ts
  modified:
    - src/backend/claude/types.ts
    - src/backend/claude/types/process-types.ts
    - src/backend/claude/constants.ts
    - src/backend/claude/protocol.ts
    - src/backend/claude/protocol-io.ts
    - src/backend/claude/registry.ts

key-decisions:
  - "Used absolute path aliases (@/backend/...) in new protocol.ts for logger and event-emitter-types imports"
  - "Registry shim uses inline import() types for function signatures instead of separate type import"

patterns-established:
  - "Move-and-shim: copy file to domain, update internal imports, replace original with re-export shim"
  - "Instance-based registry: ProcessRegistry class with no module-level state (DOM-04)"

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 2 Plan 1: Foundation Types, Protocol, and Registry Summary

**Claude protocol types, NDJSON handler, and instance-based ProcessRegistry moved to session domain with backward-compatible shims at all old paths**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T12:09:55Z
- **Completed:** 2026-02-10T12:18:47Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Moved types.ts, types/process-types.ts, constants.ts, protocol.ts, protocol-io.ts to src/backend/domains/session/claude/
- Co-located test files (types.test.ts, protocol.test.ts) at new location, 182 tests passing
- Refactored ProcessRegistry from module-level Map to instance-based class (DOM-04 compliance)
- Created backward-compatible shims at all 6 old paths; existing consumers unaffected
- All verification passing: pnpm typecheck, 182 domain tests, 161 old-path tests, dep-cruiser, knip

## Task Commits

Each task was committed atomically:

1. **Task 1: Move types, constants, and protocol layer** - `2198706` (feat)
2. **Task 2: Refactor registry to instance-based ProcessRegistry** - `e606ae7` (feat)

## Files Created/Modified
- `src/backend/domains/session/claude/types.ts` - Claude protocol types and Zod schemas (canonical location)
- `src/backend/domains/session/claude/types/process-types.ts` - Process status and resource types
- `src/backend/domains/session/claude/constants.ts` - Timeout and limit constants
- `src/backend/domains/session/claude/protocol.ts` - ClaudeProtocol NDJSON handler (updated imports to absolute paths)
- `src/backend/domains/session/claude/protocol-io.ts` - Protocol IO adapter
- `src/backend/domains/session/claude/protocol.test.ts` - 53 protocol tests
- `src/backend/domains/session/claude/types.test.ts` - 129 type guard tests
- `src/backend/domains/session/claude/registry.ts` - Instance-based ProcessRegistry class (DOM-04)
- `src/backend/claude/types.ts` - Re-export shim
- `src/backend/claude/types/process-types.ts` - Re-export shim
- `src/backend/claude/constants.ts` - Re-export shim
- `src/backend/claude/protocol.ts` - Re-export shim
- `src/backend/claude/protocol-io.ts` - Re-export shim
- `src/backend/claude/registry.ts` - Backward-compatible shim with singleton + free functions

## Decisions Made
- Used absolute path aliases (`@/backend/services/logger.service`, `@/backend/lib/event-emitter-types`) in the new protocol.ts instead of relative paths, since the file moved deeper into the directory tree
- Registry shim uses inline `import()` type expressions for function signatures rather than a separate type-only import, keeping the shim simpler

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Session domain's claude/ subdirectory is established with types, protocol, and registry
- Move-and-shim pattern validated and ready for Plans 02-06 (process, permissions, session, monitoring, index)
- All existing consumers continue to work via shims; no import changes needed yet

## Self-Check: PASSED

All 14 files verified present. Both commit hashes (2198706, e606ae7) verified in git log.

---
*Phase: 02-session-domain-consolidation*
*Completed: 2026-02-10*
