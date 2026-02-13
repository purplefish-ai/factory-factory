# Factory Factory

## What This Is

A developer tool that manages workspaces with AI agents, GitHub integration, CI monitoring, and auto-fix capabilities. The backend has 6 domain modules under `src/backend/domains/` with an orchestration layer for cross-domain coordination. Project-level UI surfaces (sidebar, Kanban, workspace list) display real-time workspace state via WebSocket-pushed snapshots.

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
- ✓ In-memory snapshot store with per-workspace entries — v1.1
- ✓ Event-driven delta updates from domain mutations — v1.1
- ✓ WebSocket push of changed snapshots to clients — v1.1
- ✓ Safety-net reconciliation poll (~1 min cadence) — v1.1
- ✓ Sidebar, Kanban, and workspace list consume single snapshot query — v1.1
- ✓ Debug metadata on each snapshot entry (version, computedAt, source) — v1.1

### Active

- [ ] ACP runtime module in session domain for subprocess + connection management
- [ ] ACP-only provider communication for both Claude and Codex sessions
- [ ] ACP session lifecycle mapping (initialize, session/new, session/prompt, session/cancel, session/load, session/set_config_option)
- [ ] ACP permission option selection replacing boolean permission UX
- [ ] ACP configOptions-driven model/mode/reasoning controls
- [ ] Legacy protocol removal (Claude NDJSON, Codex app-server)
- [ ] ACP-focused integration tests

### Out of Scope

- Database schema changes — snapshot is in-memory, not persisted
- Workspace detail/session-specific polling — different lifecycle, stays as-is
- Agent status detail — snapshot carries state only (idle/busy/waiting/needs-attention), not reasons
- Persistent snapshot (write to DB/disk) — derived cache, rebuild on restart is fast (~100ms)
- Distributed pub/sub (Redis, NATS) — single-process Node.js server
- Client-side snapshot computation — would duplicate server-side business logic

## Current Milestone: v1.2 ACP Cutover

**Goal:** Replace custom Claude NDJSON and Codex app-server protocols with ACP-only runtime using Zed's production adapters.

**Target features:**
- Single ACP client runtime in session domain (stdio subprocess + ClientSideConnection)
- ACP as only provider communication contract for both Claude and Codex
- Permission handling via ACP option selection end-to-end
- Model/mode/reasoning controls via ACP configOptions
- Full removal of legacy protocol code paths

**GitHub issue:** #996

## Context

**Current state:** The backend has 6 domain modules in `src/backend/domains/` (session, workspace, github, ratchet, terminal, run-script), each with barrel-file encapsulation. Cross-domain flows use bridge interfaces wired at startup via `src/backend/orchestration/domain-bridges.ts`. Infrastructure services (logger, config, scheduler, port, health, snapshot store, etc.) remain in `src/backend/services/`. All imports use domain barrel paths. 18 dependency-cruiser rules enforce boundaries.

**Snapshot service:** Sidebar, Kanban, and workspace list read from a single WebSocket-pushed snapshot instead of independent polling loops. Event-driven updates flow through an orchestration-layer event collector with 150ms coalescing. A 60-second safety-net reconciliation catches missed events and computes git stats. 32 v1.1 requirements satisfied, 2064 tests passing.

**Tech stack:** TypeScript, Express, tRPC, Prisma, Vitest, Biome, dependency-cruiser
**Test suite:** 2064 tests across 111 files
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
| In-memory snapshot over DB denormalization | Avoid schema changes, faster reads, simpler invalidation | ✓ Good — zero schema changes, rebuild <100ms |
| Event-driven + safety-net poll | Events for speed, poll for correctness — catch missed events | ✓ Good — ~200ms event latency, 60s reconciliation catches drift |
| WebSocket push for snapshot delivery | Eliminates frontend polling for project-level surfaces | ✓ Good — sidebar/kanban/list all real-time |
| State-only agent status in snapshot | Keep snapshot lightweight; details via workspace detail view | ✓ Good — simple idle/busy/waiting/needs-attention state |
| 150ms trailing-edge debounce for coalescing | Midpoint of 100-200ms requirement, balances latency vs dedup | ✓ Good — effective burst handling |
| Field-level timestamps for concurrent updates | Prevents reconciliation from overwriting newer event-driven data | ✓ Good — clean concurrent update safety |

## Constraints

- **Backward compatibility**: All tRPC endpoints continue to work identically — validated by 2064 tests
- **Test parity**: All existing tests pass; new co-located tests added per domain
- **AppContext**: `app-context.ts` references domain modules via barrel imports
- **Architecture boundaries**: 18 dependency-cruiser rules, zero violations across 736 modules

---
*Last updated: 2026-02-13 after v1.2 milestone start*
