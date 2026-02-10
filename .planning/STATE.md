# Project State

**Project:** SRP Consolidation & Domain Module Refactor
**Status:** In Progress
**Current Phase:** 08-orchestration-layer (Plan 04 of 04 complete)
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
| 7 | Run Script Domain Consolidation | Complete | All 2 plans done |
| 8 | Orchestration Layer | Complete | All 4 plans done |
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
| Cross-domain workspace-state-machine via shim | 2026-02-10 | startup-script uses @/backend/services/ shim path to avoid cross-domain violation (07-02) |
| Selective named exports in run-script barrel | 2026-02-10 | Barrel uses explicit named re-exports (no export *) per established convention (07-02) |
| clearInitMode made public for orchestrator | 2026-02-10 | Orchestrator needs access to clear init mode after worktree creation (08-01) |
| Direct module paths for workspace in orchestrators | 2026-02-10 | Avoids circular dep: workspace barrel -> creation.service -> orchestrator -> workspace barrel (08-01) |
| Module-level cached GitHub username in orchestrator | 2026-02-10 | Cross-domain caching moved from WorktreeLifecycleService instance field to orchestrator module scope (08-01) |
| Knip ignore for orchestration directory | 2026-02-10 | Added src/backend/orchestration/*.ts to knip ignore for new orchestration files (08-01) |

| Bridge interfaces with lightweight types | 2026-02-10 | Ratchet bridges.ts defines own types, no dependency on github/session domain types (08-02) |
| configure() + fail-fast getter pattern | 2026-02-10 | Each ratchet service has configure(bridges) and private get session()/github() that throw if unconfigured (08-02) |
| Bridge injection in tests over vi.mock | 2026-02-10 | ci-fixer test uses configure({session: mockBridge}) instead of vi.mock module path (08-02) |
| Direct import for configureRatchetBridges | 2026-02-10 | Server.ts imports directly (not via barrel) to avoid circular dep with reconciliation (08-03) |
| Locally-defined fixer types in github bridges | 2026-02-10 | GitHubFixerAcquireInput/Result defined locally to avoid cross-domain dep on ratchet (08-03) |
| Bridge injection in pr-snapshot test | 2026-02-10 | configure({kanban: mock}) replaces vi.mock for cross-domain kanban-state service (08-03) |
| Locally-defined types in session bridges | 2026-02-10 | SessionInitPolicyInput uses string status to avoid Prisma cross-domain dep (08-04) |
| Cast at orchestration boundary | 2026-02-10 | getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput) bridges string vs enum types (08-04) |
| Merged ratchet-bridges into domain-bridges | 2026-02-10 | Single configureDomainBridges() replaces separate configureRatchetBridges() (08-04) |
| Intra-domain relative imports in session handlers | 2026-02-10 | 11 handler files converted from @/backend/services/ shim to relative paths (08-04) |

## Blockers

None.

## Context for Next Session

Phase 8 (Orchestration Layer) complete -- all 4 plans done.
Plan 01: workspace-init and workspace-archive orchestrators.
Plan 02: Ratchet domain bridge injection pattern.
Plan 03: Workspace-query, kanban-state, pr-review-fixer, pr-snapshot bridge injection + ratchet bridge wiring.
Plan 04: Session and run-script bridge injection. Consolidated configureDomainBridges() replaces configureRatchetBridges(). All 6 domains have zero cross-domain imports. dependency-cruiser validates clean.
Ready for Phase 9 (AppContext & Import Rewiring).

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
| 07 | 02 | 3min | 2 | 4 |
| 08 | 01 | 12min | 2 | 14 |
| 08 | 02 | 2min | 2 | 7 |
| 08 | 03 | 7min | 2 | 12 |
| 08 | 04 | 8min | 2 | 24 |

---
*State initialized: 2026-02-10*
*Last session: 2026-02-10T19:34:07Z -- Completed 08-04-PLAN.md*
