# Project State

**Project:** SRP Consolidation & Domain Module Refactor
**Status:** In Progress
**Current Phase:** 03-workspace-domain-consolidation (Plan 04 of 05 complete)
**Last Updated:** 2026-02-10

## Progress

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Foundation & Domain Scaffolding | Complete | Plan 01 done (2min) |
| 2 | Session Domain Consolidation | Complete | All 6 plans done |
| 3 | Workspace Domain Consolidation | In Progress | Plan 04 of 05 done |
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
| Static imports in smoke test | 2026-02-10 | Biome forbids await import(); use static imports (02-06) |
| No knip changes for shims | 2026-02-10 | Existing globs already cover all re-export shim paths (02-06) |
| EventForwarderContext in barrel | 2026-02-10 | Additional type export for external consumers (02-06) |
| Direct module paths in shims (not barrel) | 2026-02-10 | Re-export shims use direct module path to avoid circular deps (03-01) |
| Cross-domain imports via absolute paths | 2026-02-10 | kanban-state uses @/backend/services/ for cross-domain deps (03-01) |
| Intra-domain relative in workspace state/ | 2026-02-10 | kanban-state -> flow-state via ./flow-state (03-01) |
| Absolute @/ imports in domain files | 2026-02-10 | Cross-layer refs use @/backend/ paths in workspace domain (03-02) |
| Absolute mock paths in domain tests | 2026-02-10 | vi.mock paths updated to @/backend/ matching new imports (03-02) |
| Absolute dynamic import for init.trpc | 2026-02-10 | '@/backend/trpc/workspace/init.trpc' prevents path breakage (03-04) |
| cachedReviewCount as instance field (DOM-04) | 2026-02-10 | Moved from module scope to private field on WorkspaceQueryService (03-04) |
| gitConcurrencyLimit kept module-level | 2026-02-10 | Stateless pLimit limiter stays as module const, not mutable state (03-04) |
| Intra-domain relative in workspace query/ | 2026-02-10 | query/ -> state/ via ../state/kanban-state, ../state/flow-state (03-04) |

## Blockers

None.

## Context for Next Session

Phase 3 IN PROGRESS: Workspace domain consolidation nearly complete.
Plan 03-01 moved flow-state, kanban-state, and init-policy to domains/workspace/state/.
Plan 03-02 moved state-machine, data, and activity services to domains/workspace/lifecycle/.
Plan 03-04 moved creation service to lifecycle/ and query service to query/.
Dynamic import in creation.service.ts fixed to use absolute @/ alias.
cachedReviewCount refactored from module-level to instance field (DOM-04).
All re-export shims at old paths. pnpm typecheck passes. 12 creation tests + all others passing.
Plan 03-05 remains (workspace barrel population).

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 2min | 2 | 8 |
| 02 | 01 | 8min | 2 | 14 |
| 02 | 03 | 8min | 2 | 24 |
| 02 | 02 | 9min | 2 | 20 |
| 02 | 04 | 20min | 2 | 25 |
| 02 | 06 | 3min | 2 | 2 |
| 03 | 01 | 5min | 2 | 9 |
| 03 | 02 | 5min | 2 | 8 |
| 03 | 04 | 5min | 2 | 5 |

---
*State initialized: 2026-02-10*
*Last session: 2026-02-10T15:13:00Z -- Completed 03-04-PLAN.md*
