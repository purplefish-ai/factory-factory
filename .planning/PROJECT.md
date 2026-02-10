# SRP Consolidation & Domain Module Refactor

## What This Is

A structural refactor of factory-factory's backend to establish clear domain modules with single ownership, co-located tests, and straightforward data flow. Currently 85+ services in a flat `src/backend/services/` directory with scattered responsibilities — Session logic alone spans 4+ files across different directories. This project consolidates each core domain into a self-contained module following the pattern already emerging in `src/backend/domains/session/`.

## Core Value

Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## Requirements

### Validated

<!-- Existing capabilities that must be preserved through the refactor. -->

- ✓ Workspace CRUD, state machine, git worktree management — existing
- ✓ Session lifecycle (create, run, pause, resume, complete) — existing
- ✓ Terminal management (pty spawning, output streaming, monitoring) — existing
- ✓ GitHub integration (PRs, issues, CI status, ratchet/auto-fix) — existing
- ✓ tRPC API layer with typed procedures — existing
- ✓ Resource accessor pattern (Prisma abstraction) — existing
- ✓ Real-time WebSocket events (chat, terminal, status) — existing

### Active

<!-- The refactoring goals. -->

- [ ] Session domain module — consolidate `session.service.ts`, `SessionManager`, `session.process-manager.ts`, `session-file-logger.service.ts`, and `src/backend/domains/session/` into one `src/backend/domains/session/` module
- [ ] Workspace domain module — consolidate `workspace-*.service.ts` sprawl (creation, state machine, archival, ratchet interactions) into `src/backend/domains/workspace/`
- [ ] Terminal domain module — consolidate `terminal.service.ts` with its static Maps and monitoring into `src/backend/domains/terminal/`
- [ ] GitHub domain module — consolidate `github-cli.service.ts` and related PR/issue logic into `src/backend/domains/github/`
- [ ] Orchestration layer — cross-domain flows (e.g., workspace creation triggers session setup) use an explicit orchestration/saga pattern rather than service-to-service calls
- [ ] No circular imports — clean dependency graph where domains depend downward (on accessors/shared) but never on each other
- [ ] Unit test suite per domain module — each domain's public API covered by co-located tests
- [ ] Static Maps eliminated — replace class-level static state with instance-based services or proper DI

### Out of Scope

- Frontend refactoring — this project is backend-only
- New features — no new capabilities, purely structural
- Database schema changes — Prisma models stay as-is
- Performance optimization — not a goal unless it falls out naturally from the refactor
- Auth system — no auth changes

## Context

**Current state:** The backend has an emerging domain pattern (`src/backend/domains/session/`) but most logic lives in a flat `src/backend/services/` with 85+ files. The `app-context.ts` file wires everything together as a DI container. Resource accessors in `src/backend/resource_accessors/` already provide a clean data layer.

**Key pain points identified:**
- Session ownership is split across `session.service.ts`, `src/backend/claude/session.ts` (SessionManager), `session.process-manager.ts`, and `src/backend/domains/session/` — unclear who owns what
- Workspace has 5+ services (`workspace-creation.service.ts`, `workspace-state-machine.service.ts`, `workspace-archival.service.ts`, etc.) that cross-call each other
- Static Maps in `RunScriptService`, `TerminalService`, and `ProcessRegistry` create hidden global state that's hard to test
- Services import other services freely, creating an unclear dependency graph
- Test gaps in cross-service flows (state machine races, process crash recovery)

**Existing pattern to follow:** `src/backend/domains/session/` is the emerging domain module pattern. Each domain module should co-locate its service logic, types, and tests.

**Tools already available:**
- Dependency Cruiser (`dependency-cruiser@17.3.7`) for validating import graph
- Vitest for unit testing
- Biome for formatting/linting

## Constraints

- **Backward compatibility**: All tRPC endpoints must continue to work identically — this is a pure internal refactor
- **Incremental commits**: Each domain can be refactored independently, but this is a big-bang execution
- **Test parity**: Any existing tests must continue to pass; new tests added per domain
- **AppContext**: `app-context.ts` remains the DI wiring point but should reference domain modules instead of individual services

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Domain module per concept (`src/backend/domains/{name}/`) | Follows emerging pattern, co-locates related code | — Pending |
| Orchestration layer for cross-domain flows | Prevents circular dependencies, makes coordination explicit | — Pending |
| Big-bang refactor (not incremental phases) | User comfortable with churn, faster to get to clean state | — Pending |
| Resource accessors stay separate | Already clean abstraction, no SRP violation | — Pending |

---
*Last updated: 2026-02-10 after initialization*
