# SRP Consolidation & Domain Module Refactor

## What This Is

A structural refactor of factory-factory's backend that established clear domain modules with single ownership, co-located tests, and straightforward data flow. Consolidated 45+ flat services from `src/backend/services/` into 6 domain modules under `src/backend/domains/`, with an orchestration layer for cross-domain coordination and 18 dependency-cruiser rules enforcing architectural boundaries.

## Core Value

Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## Requirements

### Validated

- ✓ Session domain module — consolidated SessionManager, process management, chat services, file logger into `src/backend/domains/session/` — v1.0
- ✓ Workspace domain module — consolidated creation, state machine, worktree lifecycle, kanban state into `src/backend/domains/workspace/` — v1.0
- ✓ Terminal domain module — consolidated terminal.service.ts with instance-based state into `src/backend/domains/terminal/` — v1.0
- ✓ GitHub domain module — consolidated github-cli, PR snapshot, review monitoring into `src/backend/domains/github/` — v1.0
- ✓ Ratchet domain module — consolidated ratchet polling, CI monitoring, fixer dispatch into `src/backend/domains/ratchet/` — v1.0
- ✓ Run-script domain module — consolidated run-script execution, state machine, startup scripts into `src/backend/domains/run-script/` — v1.0
- ✓ Orchestration layer — cross-domain flows use bridge interfaces + orchestrators, no direct service coupling — v1.0
- ✓ No circular imports — 18 dep-cruiser rules, zero violations across 682 modules — v1.0
- ✓ Unit test suite per domain — co-located tests, 1609 tests passing — v1.0
- ✓ Static Maps eliminated (DOM-04) — module-level mutable state replaced with instance fields — v1.0
- ✓ Backward compatibility — all tRPC endpoints, WebSocket handlers, and CLI commands work identically — v1.0

### Active

(No active requirements — milestone complete)

### Out of Scope

- Frontend refactoring — this project was backend-only
- New features — no new capabilities, purely structural
- Database schema changes — Prisma models stayed as-is
- Performance optimization — not a goal
- Auth system — no auth changes

## Context

**Current state:** The backend has 6 domain modules in `src/backend/domains/` (session, workspace, github, ratchet, terminal, run-script), each with barrel-file encapsulation. Cross-domain flows use bridge interfaces wired at startup via `src/backend/orchestration/domain-bridges.ts`. Infrastructure services (logger, config, scheduler, port, health, etc.) remain in `src/backend/services/`. All imports use domain barrel paths. 18 dependency-cruiser rules enforce boundaries.

**Tech stack:** TypeScript, Express, tRPC, Prisma, Vitest, Biome, dependency-cruiser
**Test suite:** 1609 tests across 90 files
**Architecture docs:** `AGENTS.md`, `.planning/codebase/ARCHITECTURE.md`

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Domain module per concept (`src/backend/domains/{name}/`) | Follows emerging pattern, co-locates related code | ✓ Good — clean ownership |
| Orchestration layer for cross-domain flows | Prevents circular dependencies, makes coordination explicit | ✓ Good — bridges + orchestrators work well |
| Big-bang refactor (not incremental phases) | User comfortable with churn, faster to get to clean state | ✓ Good — completed in 10 phases, single day |
| Resource accessors stay separate | Already clean abstraction, no SRP violation | ✓ Good — unchanged |
| Move-and-shim pattern | Copy to domain, update imports, shim at old path for gradual migration | ✓ Good — enabled incremental domain consolidation |
| Bridge interfaces with fail-fast getters | configure() + private get session() pattern for cross-domain deps | ✓ Good — clean DI without constructor injection |
| Instance-based state over static Maps (DOM-04) | Eliminates hidden global state, improves testability | ✓ Good — all tests use fresh instances |
| Barrel bypass exceptions for circular deps | conversation-rename.interceptor.ts, workspace-init.orchestrator.ts retain direct paths | ⚠️ Revisit — documented exceptions, not ideal |

## Constraints

- **Backward compatibility**: All tRPC endpoints continue to work identically — validated by 1609 tests + smoke test
- **Test parity**: All existing tests pass; new co-located tests added per domain
- **AppContext**: `app-context.ts` references domain modules via barrel imports

---
*Last updated: 2026-02-10 after v1.0 milestone*
