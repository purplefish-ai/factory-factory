# Project State

**Project:** SRP Consolidation & Domain Module Refactor
**Status:** In Progress
**Current Phase:** 07-run-script-domain-consolidation (Plan 01 of 02 complete)
**Last Updated:** 2026-02-10

## Progress

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Foundation & Domain Scaffolding | Complete | Plan 01 done (2min) |
| 2 | Session Domain Consolidation | Complete | All 6 plans done |
| 3 | Workspace Domain Consolidation | Complete | All 5 plans done |
| 4 | GitHub Domain Consolidation | Complete | All 3 plans done |
| 5 | Ratchet Domain Consolidation | Complete | All 3 plans done |
| 6 | Terminal Domain Consolidation | Complete | Plan 01 done (4min) |
| 7 | Run Script Domain Consolidation | In Progress | Plan 01 done (7min) |
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
| Cross-domain shim for sessionDomainService | 2026-02-10 | services/session-domain.service.ts shim avoids cross-domain import violation (03-03) |
| Instance-method wrappers in shim | 2026-02-10 | Shim exports wrapper functions that delegate to singleton instance methods (03-03) |
| Selective barrel exports for workspace domain | 2026-02-10 | Named re-exports (no export *) following Phase 2 session domain pattern (03-05) |
| Biome auto-sorts barrel exports | 2026-02-10 | Exports reordered alphabetically by import path; section comments remain as landmarks (03-05) |
| Knip ignore glob for domain services | 2026-02-10 | src/backend/domains/**/*.service.ts added to knip ignore (04-01) |
| Biome auto-sorts domain file imports | 2026-02-10 | Imports reordered alphabetically by path in domain files (04-01) |
| Intra-domain relative for review subsystem | 2026-02-10 | pr-review-monitor uses ./github-cli.service and ./pr-review-fixer.service (04-02) |
| Cross-domain absolute for review services | 2026-02-10 | pr-review-fixer uses @/backend/services/ for fixer-session, logger, session (04-02) |
| Biome auto-sorts barrel exports (GitHub) | 2026-02-10 | Exports reordered alphabetically by import path; section comments remain as landmarks (04-03) |
| Knip ignore for domain service files | 2026-02-10 | ci-monitor has no external consumers; added domains/**/*.service.ts to knip ignore (05-01) |
| Cross-domain import via services/ shim | 2026-02-10 | ratchet.service imports sessionDomainService through services/ shim, not direct domain path (05-02) |
| Biome auto-sorts ratchet barrel exports | 2026-02-10 | Exports reordered alphabetically by import path; section comments remain as landmarks (05-03) |
| Logger import absolute for cross-domain | 2026-02-10 | Terminal service uses @/backend/services/logger.service (06-01) |
| TerminalService class exported for tests | 2026-02-10 | Class export enables fresh instances in unit tests (06-01) |
| Direct module path in terminal shim | 2026-02-10 | Shim imports from /terminal.service not barrel to avoid circular deps (06-01) |
| biome-ignore for pre-existing complexity | 2026-02-10 | startRunScript/stopRunScript exceed max complexity; inherent to process lifecycle (07-01) |
| registerShutdownHandlers() pattern | 2026-02-10 | Process signal handlers encapsulated in explicit method called after singleton creation (07-01) |
| Instance type in app-context for RunScriptService | 2026-02-10 | Changed from typeof RunScriptService to RunScriptService (instance type) (07-01) |

## Blockers

None.

## Context for Next Session

Phase 7 plan 01 complete: Run-script core services moved to domain.
2 files in src/backend/domains/run-script/: run-script-state-machine.service, run-script.service + 1 test.
RS-02 instance conversion complete: 0 static members, 0 module-level mutable state.
Re-export shims at old services/ paths. app-context.ts updated to instance type.
Ready for Phase 7 Plan 02 (barrel exports and smoke test).

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
| 03 | 03 | 13min | 1 | 5 |
| 03 | 05 | 3min | 2 | 2 |
| 05 | 01 | 5min | 2 | 9 |
| 05 | 02 | 7min | 2 | 6 |
| 05 | 03 | 2min | 2 | 2 |
| 04 | 01 | 11min | 2 | 7 |
| 04 | 02 | 11min | 2 | 5 |
| 04 | 03 | 2min | 2 | 2 |
| 06 | 01 | 4min | 2 | 5 |
| 07 | 01 | 7min | 2 | 7 |

---
*State initialized: 2026-02-10*
*Last session: 2026-02-10T17:52:52Z -- Completed 07-01-PLAN.md*
