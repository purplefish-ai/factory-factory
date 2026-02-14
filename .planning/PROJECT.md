# Factory Factory

## What This Is

A developer tool that manages workspaces with AI agents, GitHub integration, CI monitoring, and auto-fix capabilities. The backend has 6 domain modules under `src/backend/domains/` with an orchestration layer for cross-domain coordination. All agent sessions use the Agent Client Protocol (ACP) via subprocess-per-session model with native permission options, config controls, and event streaming. Project-level UI surfaces display real-time workspace state via WebSocket-pushed snapshots.

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
- ✓ ACP runtime module in session domain (subprocess + ClientSideConnection) — v1.2
- ✓ ACP-only provider communication for both Claude and Codex sessions — v1.2
- ✓ ACP session lifecycle (initialize, session/new, session/prompt, session/cancel, session/load, session/set_config_option) — v1.2
- ✓ ACP permission option selection (allow once/always, deny once/always) replacing boolean UX — v1.2
- ✓ ACP configOptions-driven model/mode/reasoning controls — v1.2
- ✓ Legacy protocol removal (Claude NDJSON + Codex app-server deleted, ~50 files, 17K lines) — v1.2
- ✓ ACP-focused integration tests (1905 tests passing) — v1.2

### Active

(None — planning next milestone)

### Out of Scope

- Database schema changes — snapshot is in-memory, not persisted
- Workspace detail/session-specific polling — different lifecycle, stays as-is
- Agent status detail — snapshot carries state only (idle/busy/waiting/needs-attention), not reasons
- Persistent snapshot (write to DB/disk) — derived cache, rebuild on restart is fast (~100ms)
- Distributed pub/sub (Redis, NATS) — single-process Node.js server
- Client-side snapshot computation — would duplicate server-side business logic
- Backward compatibility with old WebSocket message contracts — pre-release breaking change per #996
- Legacy provider wire implementations behind flags — doubles maintenance surface
- Remote/HTTP agent transport — FF runs agents as local subprocesses, stdio only

## Context

**Current state:** Shipped v1.2 with 114,651 LOC TypeScript across 6 domain modules. All agent sessions use ACP subprocess model via `@agentclientprotocol/sdk`. Session domain has subdirectories: `acp/` (runtime manager, process handles, event translation, permissions), `lifecycle/` (session service, hydrator), `chat/` (message handling, event forwarding), `data/` (file reader, JSONL persistence), `store/` (in-memory state), `logging/`.

**ACP architecture:** Each session spawns an adapter subprocess (`claude-code-acp` or `codex-acp`) with stdio-based JSON-RPC. AcpEventTranslator maps 11 SessionUpdate variants to FF delta events. AcpPermissionBridge suspends SDK callbacks pending user multi-option selection. Agent-provided configOptions drive model/mode/reasoning UI selectors.

**Tech stack:** TypeScript, Express, tRPC, Prisma, Vitest, Biome, dependency-cruiser, @agentclientprotocol/sdk
**Test suite:** 1905 tests across 123 files
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
| ACP subprocess per session (not singleton) | Aligns with ACP model, isolates sessions, clean lifecycle | ✓ Good — no shared state between sessions |
| Non-detached spawn for orphan prevention | Children receive SIGHUP on parent death | ✓ Good — no orphan processes |
| Prompt response as turn-complete signal | Avoids event ordering inversion from notification-based detection | ✓ Good — reliable turn completion |
| AcpEventTranslator stateless pattern | Switch on sessionUpdate discriminant, returns delta arrays | ✓ Good — easy to extend, testable |
| Permission bridge with Promise suspension | Async SDK callbacks wait for user input via stored resolve callbacks | ✓ Good — clean async permission lifecycle |
| Agent-authoritative config options | UI renders what agent reports, no hardcoded options | ✓ Good — adapts to different agent capabilities |
| Unified AcpRuntimeManager (no provider-specific managers) | Single code path for all providers | ✓ Good — eliminated duplication |
| Deprecated stubs for incremental migration | 12 SessionService stubs preserved during Phase 22 cleanup | ⚠️ Revisit — stubs should be removed when consumers migrate |

## Constraints

- **Backward compatibility**: All tRPC endpoints continue to work identically — validated by 1905 tests
- **Test parity**: All existing tests pass; new co-located tests added per domain
- **AppContext**: `app-context.ts` references domain modules via barrel imports
- **Architecture boundaries**: dependency-cruiser rules enforce domain boundaries, zero violations

---
*Last updated: 2026-02-14 after v1.2 milestone*
