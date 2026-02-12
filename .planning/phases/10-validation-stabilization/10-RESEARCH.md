# Phase 10: Validation & Stabilization - Research

**Researched:** 2026-02-10
**Domain:** CI validation, backward compatibility verification, architecture documentation
**Confidence:** HIGH

## Summary

Phase 10 is the final validation phase of a 10-phase SRP refactor. Unlike prior phases that moved code, Phase 10 moves nothing -- it verifies that all prior work (Phases 1-9) left the codebase in a clean, backward-compatible state, and then documents the resulting architecture for future contributors.

The codebase is already in excellent shape. All five automated checks pass right now: 1609 tests pass, TypeScript type checking passes, Biome lint/format passes, dependency-cruiser reports zero violations (682 modules, 2467 dependencies), and `pnpm build` succeeds. The only substantive work is: (a) running all CI-equivalent checks systematically and recording results, (b) performing a `pnpm dev` smoke test verifying the application actually starts, (c) updating stale documentation (the pre-refactor `.planning/codebase/ARCHITECTURE.md` and `.architecture/HOTSPOTS_2026-02.md` reference the old flat services structure), (d) updating AGENTS.md to describe the domain module structure, and (e) cleaning up minor Knip configuration hints.

**Primary recommendation:** Structure this as 2-3 small plans: (1) run all CI checks + smoke test + record results, (2) update architecture documentation and AGENTS.md to reflect post-refactor structure, (3) update REQUIREMENTS.md traceability and ROADMAP.md completion status.

## Standard Stack

This phase introduces no new libraries. It uses the project's existing toolchain:

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Vitest | ^4.0.18 | Test runner | Already configured, runs 1609 tests across 90 files |
| TypeScript | ^5.9.3 | Type checking | Strict mode, `pnpm typecheck` → `tsc --noEmit` |
| Biome | ^2.3.13 | Lint + format | `pnpm check:fix` runs `biome check --write .` |
| dependency-cruiser | ^17.3.7 | Import graph validation | `pnpm deps:check` validates 13 architectural rules |
| Knip | ^5.83.0 | Dead code/file detection | `pnpm knip --include files,dependencies,unlisted` |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `pnpm build` | Full TypeScript + Vite build | Verifies production build works |
| `pnpm dev` | Dev server startup | Smoke test that app actually starts |
| `pnpm check:biome-ignores` | Biome suppression budget | Ensures no inline biome-ignore comments |

### Alternatives Considered
None -- this phase uses only existing tools.

**Installation:**
No new packages needed.

## Architecture Patterns

### Current Post-Refactor Backend Structure
```
src/backend/
├── agents/              # Process adapter for agent lifecycle
├── app-context.ts       # DI container (imports from domain barrels + infra services)
├── clients/             # External client wrappers
├── constants/           # Shared constants
├── db.ts                # Prisma database connection
├── domains/             # Domain modules (6 total)
│   ├── github/          # GitHub CLI, PR snapshot, review monitoring
│   ├── ratchet/         # Auto-fix: CI monitoring, fixer sessions, reconciliation
│   ├── run-script/      # Run script execution, state machine, startup scripts
│   ├── session/         # Session lifecycle, Claude process, chat, logging
│   │   ├── chat/        # Chat connection, event forwarding, message handlers
│   │   ├── claude/      # Claude client, process registry, session manager
│   │   ├── data/        # Session data access
│   │   ├── lifecycle/   # Session service, process manager, prompt builder
│   │   ├── logging/     # Session file logger
│   │   └── store/       # Session store, transcript, replay
│   ├── terminal/        # Terminal PTY management
│   └── workspace/       # Workspace lifecycle, state, query, worktree
│       ├── lifecycle/   # State machine, data, activity, creation
│       ├── query/       # Workspace query service
│       ├── state/       # Flow state, kanban, init policy
│       └── worktree/    # Worktree lifecycle management
├── interceptors/        # Message interceptors (PR detection, conversation rename)
├── lib/                 # Shared backend utilities
├── middleware/           # Express middleware
├── orchestration/       # Cross-domain coordination (bridges, workspace init/archive)
├── prompts/             # Prompt template loading
├── resource_accessors/  # Prisma data access layer (11 accessors)
├── routers/             # Express + WebSocket + MCP routers
├── schemas/             # Zod validation schemas
├── server.ts            # Server creation and lifecycle
├── services/            # Infrastructure services ONLY (25 files)
├── testing/             # Test setup and utilities
├── trpc/                # tRPC router definitions (8 routers)
├── types/               # Shared backend types
└── utils/               # Utility functions
```

### Pattern 1: Domain Module with Barrel File
**What:** Each domain lives in `src/backend/domains/{name}/` with an `index.ts` barrel file that is the sole public API.
**When to use:** All domain access goes through the barrel.
**Example:**
```typescript
// Consumers import from barrel only:
import { sessionService, sessionDomainService } from '@/backend/domains/session';

// NEVER import internals directly:
// import { sessionService } from '@/backend/domains/session/lifecycle/session.service'; // BAD
```

### Pattern 2: Bridge Interfaces for Cross-Domain Dependencies
**What:** Domains define their own bridge interfaces in `bridges.ts`. The orchestration layer (`src/backend/orchestration/domain-bridges.orchestrator.ts`) wires concrete implementations at startup.
**When to use:** When one domain needs capabilities from another domain.
**Example:**
```typescript
// ratchet/bridges.ts - Ratchet defines what it needs
export interface RatchetSessionBridge {
  isSessionRunning(sessionId: string): boolean;
  // ...
}

// domain-bridges.orchestrator.ts - Wires at startup
ratchetService.configure({ session: ratchetSessionBridge, github: ratchetGithubBridge });
```

### Pattern 3: Infrastructure vs. Domain Services
**What:** `src/backend/services/` now contains ONLY infrastructure services (logger, config, scheduler, port, etc.). All domain-specific services live in their domain modules.
**When to use:** New infrastructure (cross-cutting, non-domain) services go in `services/`. Domain logic goes in `domains/{name}/`.

### Anti-Patterns to Avoid
- **Cross-domain imports:** Domains must NEVER import from sibling domains. Use bridges and orchestration layer.
- **Direct internal imports:** Consumers must use barrel files, never import from domain subdirectories.
- **Domain services in services/:** Domain logic must not live in `src/backend/services/`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Circular dependency detection | Custom graph walker | dependency-cruiser `no-circular` rule | Already configured with 13 rules |
| Dead code detection | Manual grep for unused exports | Knip | Already configured with proper ignore patterns |
| Import architecture enforcement | Custom ESLint rules | dependency-cruiser forbidden rules | Already has cross-domain, layer, and accessor rules |
| Test coverage verification | Manual test inventory | `pnpm test:coverage` (vitest + v8) | Already configured in vitest.config.ts |

**Key insight:** All validation tooling is already configured and working. Phase 10's job is to run them systematically, record results, and update documentation -- not to build new tooling.

## Common Pitfalls

### Pitfall 1: Assuming Passing Checks Means Backward Compatibility
**What goes wrong:** All automated checks pass, but the application doesn't actually start or has runtime behavior regressions.
**Why it happens:** Tests use mocks; type checks verify structure not behavior; dep-cruiser checks graph topology not runtime correctness.
**How to avoid:** Explicitly start `pnpm dev`, wait for successful server startup, and verify the frontend loads.
**Warning signs:** Test suite passes but `pnpm dev` crashes or hangs.

### Pitfall 2: Stale Documentation After Refactor
**What goes wrong:** Architecture docs, AGENTS.md, and ARCHITECTURE.md still describe the pre-refactor structure with "85+ services" and `src/backend/claude/` directory.
**Why it happens:** Documentation wasn't updated during the move-code phases (Phases 2-9).
**How to avoid:** Update all docs that describe backend structure: AGENTS.md, `.planning/codebase/ARCHITECTURE.md`, `.architecture/HOTSPOTS_2026-02.md`.
**Warning signs:** Docs reference `src/backend/claude/`, `src/backend/services/session.service.ts`, or "85+ services".

### Pitfall 3: Missing Requirements Traceability Updates
**What goes wrong:** REQUIREMENTS.md still shows all requirements as "Pending" even though they're all implemented.
**Why it happens:** The traceability table was created at the start but never updated during execution.
**How to avoid:** Update the traceability table and ROADMAP.md to mark all requirements/plans as complete.
**Warning signs:** Requirements like DOM-01, SESS-01, etc. still showing "Pending" status.

### Pitfall 4: Knip Configuration Drift
**What goes wrong:** Knip reports "Configuration hints" about stale ignore patterns.
**Why it happens:** The refactor changed which files exist, but Knip config wasn't updated.
**How to avoid:** Address the 4 Knip configuration hints: remove `date-fns` and `react-day-picker` from `ignoreDependencies`, remove redundant entry patterns for `src/cli/index.ts` and `src/backend/index.ts`.
**Warning signs:** Knip runs without errors but shows "Configuration hints" in output.

### Pitfall 5: Pre-Refactor HOTSPOTS Analysis is Misleading
**What goes wrong:** The `.architecture/HOTSPOTS_2026-02.md` still references the old "97 service-to-service dependencies" and recommends actions that have already been completed.
**Why it happens:** The analysis was generated pre-refactor and never regenerated.
**How to avoid:** Either regenerate the analysis or clearly mark it as superseded by the refactor.
**Warning signs:** HOTSPOTS doc references `src/backend/claude/`, recommends creating `src/backend/domain/session/` (already done as `domains/session/`).

## Code Examples

### CI Validation Command Sequence
```bash
# Run all checks in the same order as CI (.github/workflows/ci.yml)
pnpm check                    # Biome lint (read-only, no --write)
pnpm check:biome-ignores      # No inline suppressions
pnpm deps:check               # Dependency architecture validation
pnpm knip --include files,dependencies,unlisted  # Dead code check
pnpm typecheck                # TypeScript strict mode
pnpm test                     # Full test suite (1609 tests)
pnpm build                    # Production build (tsc + vite)
```

### Smoke Test Pattern
```bash
# Start dev server and verify it comes up
pnpm dev &
DEV_PID=$!
sleep 10
# Check if server is responding
curl -s http://localhost:3001/health | grep -q "ok"
RESULT=$?
kill $DEV_PID
exit $RESULT
```

### Dependency-Cruiser Rules Summary
The `.dependency-cruiser.cjs` enforces these 13 rules:
1. `no-circular` - No circular dependencies
2. `no-accessors-importing-services` - Accessors are pure data access
3. `no-accessors-importing-agents` - Accessors don't import agents
4. `no-services-importing-agents` - Services don't depend on agents
5. `no-services-importing-routers` - Services don't depend on routers
6. `no-mcp-routers-importing-agents` - MCP routers independent of agents (except task.mcp.ts)
7. `no-frontend-importing-backend` - Frontend/backend separation
8. `no-trpc-importing-accessors` - tRPC uses services, not accessors
9. `no-shared-importing-app-layers` - Shared stays framework-neutral
10. `no-backend-importing-ui-layers` - Backend doesn't import UI
11. `only-session-domain-imports-session-store` - Session store single-writer
12. `no-cross-domain-imports` - Domains are isolated
13. `only-accessors-import-db` - DB access through accessors only
14. `no-routers-importing-accessors` - Routers use services

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 45+ service files in flat `src/backend/services/` | 6 domain modules under `src/backend/domains/` | Phases 2-9 (this refactor) | Clear domain ownership, enforced by dep-cruiser |
| `src/backend/claude/` separate directory | Absorbed into `src/backend/domains/session/claude/` | Phase 2 | Claude process management owned by session domain |
| Direct cross-domain imports | Bridge interfaces + orchestration layer | Phase 8 | No circular deps between domains |
| service shim re-exports for backward compat | Shims deleted, all imports rewired | Phase 9 | Clean import graph, no dead code |

**Superseded documentation:**
- `.planning/codebase/ARCHITECTURE.md` — Pre-refactor, references old flat services structure
- `.architecture/HOTSPOTS_2026-02.md` — Pre-refactor analysis, metrics no longer apply
- `.architecture/README.md` — Action plan items already completed by the refactor

## Specific Documentation Targets

### Files That Need Updating

1. **AGENTS.md** (root) — Does not mention `src/backend/domains/` at all. Needs to describe the domain module pattern.
2. **`.planning/codebase/ARCHITECTURE.md`** — Describes pre-refactor structure ("85+ services", `src/backend/claude/`, etc.). Needs rewrite or clear supersession notice.
3. **`.architecture/HOTSPOTS_2026-02.md`** — Pre-refactor analysis. Either regenerate or mark as superseded.
4. **`.architecture/README.md`** — Action plan items (Phase 1, 2, 3) are outdated; refactor completed them.
5. **`.planning/REQUIREMENTS.md`** — All 34 requirements still show "Pending" in traceability table.
6. **`.planning/ROADMAP.md`** — Phase 4 plans still marked with `[ ]` instead of `[x]`.

### New Documentation Needed

7. **Domain module structure documentation** — Can be added to AGENTS.md or as a dedicated section. Should describe: 6 domains, barrel file pattern, bridge pattern, orchestration layer, infrastructure vs. domain services split.

## Current Codebase State (Baseline)

All checks passing as of research time:

| Check | Result | Details |
|-------|--------|---------|
| `pnpm test` | PASS | 1609 tests, 90 files, 3.31s |
| `pnpm typecheck` | PASS | `tsc --noEmit` clean |
| `pnpm check:fix` | PASS | 601 files checked, no fixes applied |
| `pnpm deps:check` | PASS | 0 violations, 682 modules, 2467 dependencies |
| `pnpm build` | PASS | Backend tsc + Vite frontend build |
| `pnpm check:biome-ignores` | PASS | No inline suppressions |
| `pnpm knip` | PASS (with hints) | No unused files/deps, but 4 config hints |

### Knip Configuration Hints to Address
1. `date-fns` — Remove from `ignoreDependencies` (no longer needed)
2. `react-day-picker` — Remove from `ignoreDependencies` (no longer needed)
3. `src/cli/index.ts` — Remove redundant entry pattern
4. `src/backend/index.ts` — Remove redundant entry pattern

## Open Questions

1. **Smoke test depth**
   - What we know: `pnpm dev` starts both backend and frontend. The `pnpm build` succeeds.
   - What's unclear: How deep should the smoke test go? Just "server starts and responds to /health"? Or also verify WebSocket upgrade, tRPC endpoints?
   - Recommendation: Verify `pnpm dev` starts without errors and the /health endpoint responds. The 1609 passing tests already cover tRPC endpoint behavior. A manual smoke test should confirm server startup + page load.

2. **Architecture doc location**
   - What we know: Two architecture docs exist: `.planning/codebase/ARCHITECTURE.md` (pre-refactor analysis) and `.architecture/` directory (also pre-refactor).
   - What's unclear: Should the updated architecture go in AGENTS.md, a new ARCHITECTURE.md at root, or update the existing `.planning/codebase/ARCHITECTURE.md`?
   - Recommendation: Update AGENTS.md with the domain module information (this is the file AI agents read). Mark `.planning/codebase/ARCHITECTURE.md` and `.architecture/HOTSPOTS_2026-02.md` as superseded or update them if they serve a different audience.

3. **REQUIREMENTS.md status update format**
   - What we know: All 34 v1 requirements are satisfied. The traceability table shows all as "Pending".
   - What's unclear: Should statuses be updated to "Done" or should checkboxes be marked?
   - Recommendation: Change `- [ ]` to `- [x]` for all v1 requirements and update the traceability table status column from "Pending" to "Done".

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis — All file reads and tool runs performed against the live repository
- `pnpm test` output — 1609 tests, 90 files, verified 2026-02-10
- `pnpm deps:check` output — 682 modules, 2467 dependencies, 0 violations
- `pnpm typecheck` output — Clean `tsc --noEmit`
- `pnpm build` output — Successful backend + frontend build
- `.github/workflows/ci.yml` — CI pipeline definition (4 jobs: checks, build, storybook, test)
- `.dependency-cruiser.cjs` — 13 architectural rules verified
- `knip.json` — Dead code detection configuration

### Secondary (MEDIUM confidence)
- Phase 9 verification report (`.planning/phases/09-appcontext-import-rewiring/09-VERIFICATION.md`) — Confirms 6/6 truths verified, all WIRE requirements satisfied

### Tertiary (LOW confidence)
- None — all findings from direct codebase verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — All tools already configured and verified working
- Architecture: HIGH — Direct codebase analysis of current structure
- Pitfalls: HIGH — Identified from comparing actual state to documentation state
- Documentation gaps: HIGH — Direct comparison of docs vs. actual structure

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable — no external dependencies or version concerns)
