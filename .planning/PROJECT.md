# Factory Factory

## What This Is

A developer tool that manages workspaces with AI agents, GitHub integration, CI monitoring, and auto-fix capabilities. The backend has 6 domain modules under `src/backend/domains/` with an orchestration layer for cross-domain coordination. Project-level UI surfaces (sidebar, Kanban, workspace list) display workspace state and agent activity.

## Core Value

Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## Current Milestone: v1.1 Project Snapshot Service

**Goal:** Replace multiple independent polling loops with a single in-memory materialized view of all workspace states, pushed to clients via WebSocket.

**Target features:**
- Backend in-memory snapshot store — one entry per workspace with git state, PR status, CI status, agent state
- Event-driven delta updates — mutations update individual workspace entries as they happen
- WebSocket push — changed workspace snapshots pushed to connected clients immediately
- Safety-net reconciliation poll — periodic (once/minute) full recompute to catch missed events
- Single snapshot query — sidebar, Kanban, and workspace list all read from one source
- Debug metadata — version, computedAt, source of last update on each snapshot entry

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

- [ ] In-memory snapshot store with per-workspace entries
- [ ] Event-driven delta updates from mutations
- [ ] WebSocket push of changed snapshots to clients
- [ ] Safety-net reconciliation poll (~1 min cadence)
- [ ] Sidebar, Kanban, and workspace list consume single snapshot query
- [ ] Debug metadata on each snapshot entry (version, computedAt, source)

### Out of Scope

- Frontend refactoring — this project was backend-only (v1.0)
- Database schema changes — snapshot is in-memory, not persisted
- Workspace detail/session-specific polling — different lifecycle, stays as-is
- New UI surfaces — no dashboard or new views, just rewire existing three
- Agent status detail — snapshot carries state only (idle/busy/waiting/needs-attention), not reasons

## Context

**Current state:** The backend has 6 domain modules in `src/backend/domains/` (session, workspace, github, ratchet, terminal, run-script), each with barrel-file encapsulation. Cross-domain flows use bridge interfaces wired at startup via `src/backend/orchestration/domain-bridges.ts`. Infrastructure services (logger, config, scheduler, port, health, etc.) remain in `src/backend/services/`. All imports use domain barrel paths. 18 dependency-cruiser rules enforce boundaries.

**Current polling problem:** Sidebar, Kanban, and workspace list each poll independently on different cadences. Adding new information requires touching multiple query paths. Debugging state inconsistencies across surfaces is difficult. The snapshot service consolidates this into a single materialized view.

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
| In-memory snapshot over DB denormalization | Avoid schema changes, faster reads, simpler invalidation | — Pending |
| Event-driven + safety-net poll | Events for speed, poll for correctness — catch missed events | — Pending |
| WebSocket push for snapshot delivery | Eliminates frontend polling for project-level surfaces | — Pending |
| State-only agent status in snapshot | Keep snapshot lightweight; details via workspace detail view | — Pending |

## Constraints

- **Backward compatibility**: All tRPC endpoints continue to work identically — validated by 1609 tests + smoke test
- **Test parity**: All existing tests pass; new co-located tests added per domain
- **AppContext**: `app-context.ts` references domain modules via barrel imports

---
*Last updated: 2026-02-11 after v1.1 milestone initialization*
