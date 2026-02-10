# Project State

**Project:** SRP Consolidation & Domain Module Refactor
**Status:** In Progress
**Current Phase:** 02-session-domain-consolidation (Plan 05 of 06 complete)
**Last Updated:** 2026-02-10

## Progress

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Foundation & Domain Scaffolding | Complete | Plan 01 done (2min) |
| 2 | Session Domain Consolidation | In Progress | Plan 05/06 done |
| 3 | Workspace Domain Consolidation | Pending | Largest service sprawl |
| 4 | GitHub Domain Consolidation | Pending | — |
| 5 | Ratchet Domain Consolidation | Pending | — |
| 6 | Terminal Domain Consolidation | Pending | — |
| 7 | Run Script Domain Consolidation | Pending | — |
| 8 | Orchestration Layer | Pending | Depends on phases 2-7 |
| 9 | AppContext & Import Rewiring | Pending | Depends on phase 8 |
| 10 | Validation & Stabilization | Pending | Depends on phase 9 |

## Key Decisions

| Decision | Date | Context |
|----------|------|---------|
| Domain module per concept | 2026-02-10 | Follow emerging `src/backend/domains/session/` pattern |
| Orchestration layer for cross-domain | 2026-02-10 | Prevents circular deps, makes coordination explicit |
| Big-bang refactor | 2026-02-10 | User comfortable with churn |
| Resource accessors stay separate | 2026-02-10 | Already clean abstraction |
| Opus model profile | 2026-02-10 | Quality-first for research/planning |
| Comprehensive depth | 2026-02-10 | 10 phases with full coverage |
| Domain barrel knip ignore | 2026-02-10 | Added glob to knip ignore for placeholder barrels |
| Move-and-shim pattern validated | 2026-02-10 | Copy to domain, update imports, shim at old path (02-01) |
| Instance-based ProcessRegistry (DOM-04) | 2026-02-10 | Eliminated module-level Map in registry (02-01) |
| HistoryMessage from @/shared/claude | 2026-02-10 | Direct import vs routing through claude barrel (02-03) |
| Intra-domain relative imports | 2026-02-10 | session-domain.service.ts uses ./store/ paths (02-03) |
| Knip ignore for shim directories | 2026-02-10 | Re-export shims need knip exclusion (02-03) |
| processRegistry singleton sharing | 2026-02-10 | Old shim and new code share same Map instance (02-02) |
| Selective barrel exports | 2026-02-10 | Named exports per module, not blanket export * (02-02) |
| Individual module paths in index shim | 2026-02-10 | Prevents double-barrel re-export chains (02-02) |
| chatWsMsgCounter instance field (DOM-04) | 2026-02-10 | Moved from module scope into ChatConnectionService class (02-05) |
| Shim paths for cross-domain imports | 2026-02-10 | Use @/backend/services/ shim paths to avoid circular deps (02-05) |
| No shims for internal subdirectory files | 2026-02-10 | chat-message-handlers/ files have 0 external consumers (02-05) |
| Free-function to instance-based registry | 2026-02-10 | process-manager uses processRegistry methods directly (02-04) |
| Remove unused shims eagerly | 2026-02-10 | Shims with 0 external consumers deleted instead of kept (02-04) |
| tsconfig exclude for WIP files | 2026-02-10 | Parallel plan 05 WIP files excluded from tsc (02-04) |

## Blockers

None.

## Context for Next Session

Phase 2 Plan 05 complete: all chat services (connection, event-forwarder, message-handlers) and 15 handler files moved to domains/session/chat/.
DOM-04 fix applied: chatWsMsgCounter moved inside ChatConnectionService class.
Only Plan 06 remains (final cleanup/integration for session domain).
src/backend/services/chat*.ts now contain only re-export shims.
Phases 3-7 are independent and can be planned/executed in parallel.

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 2min | 2 | 8 |
| 02 | 01 | 8min | 2 | 14 |
| 02 | 03 | 8min | 2 | 24 |
| 02 | 02 | 9min | 2 | 20 |
| 02 | 04 | 20min | 2 | 25 |

---
*State initialized: 2026-02-10*
*Last session: 2026-02-10T13:08:00Z -- Completed 02-04-PLAN.md*
