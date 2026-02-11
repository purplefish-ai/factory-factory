# Phase 18: Architecture Validation - Research

**Researched:** 2026-02-11
**Domain:** CI validation, architecture compliance, regression verification
**Confidence:** HIGH

## Summary

Phase 18 is the final validation phase of the v1.1 Project Snapshot Service milestone. Its job is to verify that all changes from Phases 11-17 (230 files changed across the feature branch) leave the codebase in a clean, buildable, testable state that satisfies the two remaining architecture requirements: ARCH-03 (dependency-cruiser passes with zero new violations) and ARCH-04 (existing tests continue to pass with no regressions).

The codebase is almost clean but has one blocking issue: **the production build (`pnpm build`) currently fails** because `src/backend/routers/websocket/snapshots.handler.ts` and its test file use parent-relative imports (`../../app-context`) instead of the project-standard `@/backend/app-context` alias. The `check-ambiguous-relative-imports.mjs` script (which runs as the first step of `pnpm build`) rejects parent-relative imports. This is the only code fix needed. All other checks pass: 2064 tests green, typecheck clean, dependency-cruiser zero violations (736 modules, 2699 dependencies), Biome lint clean, biome-ignores budget clean. Knip has 2 pre-existing configuration hints (not blocking, but worth cleaning).

Beyond the code fix, this phase should update the REQUIREMENTS.md traceability table (all 32 items still show "Pending") and the ROADMAP.md completion status for Phase 18.

**Primary recommendation:** Structure as a single plan: (1) fix the 3 parent-relative imports in snapshots.handler.ts and snapshots.handler.test.ts, (2) run the full CI check sequence and record results, (3) update REQUIREMENTS.md and ROADMAP.md to reflect milestone completion.

## Standard Stack

This phase introduces no new libraries. It uses the project's existing validation toolchain:

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Vitest | ^4.0.18 | Test runner | Already configured, runs 2064 tests across 111 files |
| TypeScript | ^5.9.3 | Type checking | Strict mode, `pnpm typecheck` runs `tsc --noEmit` |
| Biome | ^2.3.13 | Lint + format | `pnpm check` runs `biome check .` (read-only) |
| dependency-cruiser | ^17.3.7 | Import graph validation | `pnpm deps:check` validates 18 architectural rules |
| check-ambiguous-relative-imports.mjs | N/A | Import style enforcement | Part of `pnpm build` pipeline, blocks parent-relative imports |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `pnpm build` | Full TypeScript + Vite production build | Verifies production build succeeds (ARCH-03 success criteria 3) |
| `pnpm check:biome-ignores` | Biome suppression budget | Ensures no inline biome-ignore comments |
| Knip ^5.83.0 | Dead code detection | `pnpm knip --include files,dependencies,unlisted` |

### Alternatives Considered
None -- this phase uses only existing tools.

**Installation:**
No new packages needed.

## Architecture Patterns

### Pattern 1: CI Check Sequence
**What:** Run all checks in the same order as the CI pipeline (`.github/workflows/ci.yml`).
**When to use:** Validation phases like this one.
**Example:**
```bash
# Full CI-equivalent check sequence
pnpm check                    # Biome lint (read-only, no --write)
pnpm check:imports            # No parent-relative or ambiguous imports
pnpm check:biome-ignores      # No inline suppressions
pnpm deps:check               # Dependency architecture validation (18 rules)
pnpm knip --include files,dependencies,unlisted  # Dead code check
pnpm typecheck                # TypeScript strict mode
pnpm test                     # Full test suite
pnpm build                    # Production build (tsc + tsc-alias + vite)
```

### Pattern 2: Import Style Convention
**What:** All imports must use `@/` path aliases for non-local modules. Only `./` relative imports are allowed (same directory). Parent-relative imports (`../`) are rejected by `check-ambiguous-relative-imports.mjs`.
**When to use:** Every TypeScript file in the project.
**Example:**
```typescript
// CORRECT: Use @/ alias for cross-directory imports
import { type AppContext, createAppContext } from '@/backend/app-context';

// WRONG: Parent-relative import -- build will fail
import { type AppContext, createAppContext } from '../../app-context';
```

### Anti-Patterns to Avoid
- **Parent-relative imports:** The `check-ambiguous-relative-imports.mjs` script enforces `@/` aliases for non-local imports. This runs as the first step of `pnpm build` and will fail the build.
- **Skipping checks:** All CI checks must pass, not just the two explicitly named in ARCH-03/ARCH-04. The build includes import checking, typecheck, lint, and architecture validation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import validation | Custom grep | `pnpm check:imports` (`check-ambiguous-relative-imports.mjs`) | Already catches parent-relative imports |
| Architecture validation | Manual import review | `pnpm deps:check` (dependency-cruiser with 18 rules) | Covers circular deps, cross-domain imports, layer violations |
| Regression detection | Manual test selection | `pnpm test` (full suite) | 2064 tests across 111 files, runs in ~3.5s |

**Key insight:** All validation tooling is already configured and working. Phase 18's job is to fix the one remaining issue, run checks, and record results.

## Common Pitfalls

### Pitfall 1: Parent-Relative Imports in New Files
**What goes wrong:** New files added during Phases 11-17 use `../../` imports instead of `@/` aliases, causing `pnpm build` to fail.
**Why it happens:** The `check-ambiguous-relative-imports.mjs` script is only run during `pnpm build`, not during `pnpm test` or `pnpm typecheck`. So tests and typecheck pass while the build fails.
**How to avoid:** Fix the 3 parent-relative imports in `snapshots.handler.ts` (line 20) and `snapshots.handler.test.ts` (lines 8 and 64). Change `../../app-context` to `@/backend/app-context`.
**Warning signs:** `pnpm build` fails with "Parent-relative imports are not allowed."
**Current state:** This is the ONLY blocking issue found. The specific violations are:
```
src/backend/routers/websocket/snapshots.handler.test.ts:8 -> ../../app-context
src/backend/routers/websocket/snapshots.handler.test.ts:64 -> ../../app-context
src/backend/routers/websocket/snapshots.handler.ts:20 -> ../../app-context
```

### Pitfall 2: Forgetting vi.mock Path Must Match Source Import
**What goes wrong:** After changing the import in the source file, the `vi.mock()` path in the test file must also be updated to match.
**Why it happens:** `vi.mock()` uses the same module resolution as imports. If the source imports `@/backend/app-context`, the test must mock `@/backend/app-context` (not `../../app-context`).
**How to avoid:** Update both the import (line 8) and the `vi.mock()` call (line 64) in `snapshots.handler.test.ts`.
**Warning signs:** Tests fail with "cannot find module" or mock doesn't intercept correctly.

### Pitfall 3: Knip Configuration Hints Are Not Blocking
**What goes wrong:** Knip reports 2 configuration hints about redundant entry patterns, but these are not build failures.
**Why it happens:** `src/backend/index.ts` and `src/cli/index.ts` are listed in `knip.json` `entry` array but are already discovered by other means.
**How to avoid:** These can be cleaned up as a nice-to-have but are NOT blocking for ARCH-03/ARCH-04. The Knip check in CI (`pnpm knip --include files,dependencies,unlisted`) passes with these hints present.
**Warning signs:** Knip output shows "Configuration hints (2)" but exits 0.

### Pitfall 4: REQUIREMENTS.md Traceability Not Updated
**What goes wrong:** All 32 v1.1 requirements still show `[ ]` (Pending) in the traceability table even though Phases 11-17 are all verified and complete.
**Why it happens:** Traceability table updates were not included in individual phase plans.
**How to avoid:** Update all 32 checkboxes from `- [ ]` to `- [x]` and all traceability statuses from "Pending" to "Done" as part of this phase.

## Code Examples

### Fix 1: snapshots.handler.ts Import
```typescript
// Source: src/backend/routers/websocket/snapshots.handler.ts line 20
// BEFORE (causes build failure):
import { type AppContext, createAppContext } from '../../app-context';

// AFTER (matches chat.handler.ts, terminal.handler.ts, dev-logs.handler.ts):
import { type AppContext, createAppContext } from '@/backend/app-context';
```

### Fix 2: snapshots.handler.test.ts Import and Mock
```typescript
// Source: src/backend/routers/websocket/snapshots.handler.test.ts
// BEFORE line 8:
import type { AppContext } from '../../app-context';
// AFTER:
import type { AppContext } from '@/backend/app-context';

// BEFORE line 64:
vi.mock('../../app-context', () => ({
// AFTER:
vi.mock('@/backend/app-context', () => ({
```

### Verification Command Sequence
```bash
# Run all checks that CI runs, in order
pnpm check                                        # Biome lint
pnpm check:imports                                 # Import style enforcement
pnpm check:biome-ignores                           # Biome suppression budget
pnpm deps:check                                    # Architecture rules (18 rules)
pnpm knip --include files,dependencies,unlisted    # Dead code
pnpm typecheck                                     # TypeScript
pnpm test                                          # Full test suite (2064 tests)
pnpm build                                         # Production build
```

## Current Codebase State (Pre-Fix Baseline)

All checks passing EXCEPT `pnpm build` and `pnpm check:imports`:

| Check | Result | Details |
|-------|--------|---------|
| `pnpm test` | PASS | 2064 tests, 111 files, 3.58s |
| `pnpm typecheck` | PASS | `tsc --noEmit` clean |
| `pnpm check` | PASS | 655 files checked, no fixes applied |
| `pnpm check:imports` | **FAIL** | 3 parent-relative imports in snapshots.handler files |
| `pnpm check:biome-ignores` | PASS | No inline suppressions |
| `pnpm deps:check` | PASS | 0 violations, 736 modules, 2699 dependencies, 18 rules |
| `pnpm knip` | PASS (with hints) | 0 issues, 2 configuration hints (non-blocking) |
| `pnpm build` | **FAIL** | Blocked by check:imports failure (parent-relative imports) |

### Dependency-Cruiser Rules (18 Total)
The `.dependency-cruiser.cjs` enforces these rules:
1. `no-circular` -- No circular dependencies
2. `no-accessors-importing-services` -- Accessors are pure data access
3. `no-accessors-importing-agents` -- Accessors don't import agents
4. `no-services-importing-agents` -- Services don't depend on agents
5. `no-services-importing-routers` -- Services don't depend on routers
6. `no-mcp-routers-importing-agents` -- MCP routers independent of agents (except task.mcp.ts)
7. `no-frontend-importing-backend` -- Frontend/backend separation
8. `no-trpc-importing-accessors` -- tRPC uses services, not accessors
9. `no-shared-importing-app-layers` -- Shared stays framework-neutral
10. `no-backend-importing-ui-layers` -- Backend doesn't import UI
11. `only-session-domain-imports-session-store` -- Session store single-writer
12. `no-cross-domain-imports` -- Domains are isolated
13. `no-deep-domain-imports` -- External consumers use domain barrel files only
14. `no-domains-importing-orchestration` -- Domains don't import orchestration (with documented exceptions)
15. `no-domains-importing-routers` -- Domains don't import routers/tRPC
16. `no-domains-importing-agents` -- Domains don't import agents
17. `only-accessors-import-db` -- DB access through accessors only
18. `no-routers-importing-accessors` -- Routers use services, not accessors

### Files That Need Fixing

1. **`src/backend/routers/websocket/snapshots.handler.ts`** (line 20): Change `../../app-context` to `@/backend/app-context`
2. **`src/backend/routers/websocket/snapshots.handler.test.ts`** (line 8): Change `../../app-context` to `@/backend/app-context`
3. **`src/backend/routers/websocket/snapshots.handler.test.ts`** (line 64): Change `vi.mock('../../app-context'` to `vi.mock('@/backend/app-context'`

### Documentation That Needs Updating

1. **`.planning/REQUIREMENTS.md`** -- All 32 v1.1 requirement checkboxes: `[ ]` to `[x]`, traceability status: "Pending" to "Done"
2. **`.planning/ROADMAP.md`** -- Phase 18 checkbox: `[ ]` to `[x]`, progress table status, last updated date

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Multiple polling loops (2s sidebar, 15s kanban) | Single WebSocket-pushed snapshot | Phases 11-17 | Consistent state across all UI surfaces |
| Per-surface query endpoints | Shared in-memory snapshot store | Phase 11 | O(1) reads, single source of truth |
| Direct domain queries from UI | Event-driven + reconciliation | Phases 12-14 | Sub-200ms updates with 60s safety net |
| No import style enforcement | `check-ambiguous-relative-imports.mjs` in build | Added during v1.1 (merged from main) | Parent-relative imports rejected at build time |

## Open Questions

1. **Optional Knip cleanup**
   - What we know: Knip has 2 configuration hints about redundant entry patterns (`src/backend/index.ts`, `src/cli/index.ts`). These are not blocking -- Knip exits 0.
   - What's unclear: Whether to clean them up in this phase or leave them.
   - Recommendation: Clean them up since it is trivial (remove 2 entries from `knip.json`). But this is optional and should not block the phase.

## Sources

### Primary (HIGH confidence)
- Direct codebase execution: `pnpm test` output -- 2064 tests, 111 files, verified 2026-02-11
- Direct codebase execution: `pnpm deps:check` output -- 736 modules, 2699 dependencies, 0 violations
- Direct codebase execution: `pnpm typecheck` output -- clean `tsc --noEmit`
- Direct codebase execution: `pnpm build` output -- FAIL with 3 parent-relative import violations
- Direct codebase execution: `pnpm check` output -- 655 files checked, no fixes
- Direct codebase execution: `pnpm check:imports` output -- 3 violations in snapshots handler files
- Direct codebase execution: `pnpm knip` output -- 0 issues, 2 configuration hints
- Codebase analysis: `.dependency-cruiser.cjs` -- 18 architectural rules verified
- Codebase analysis: `.github/workflows/ci.yml` -- CI pipeline (4 jobs: checks, build, storybook, test)
- Codebase analysis: `scripts/check-ambiguous-relative-imports.mjs` -- import enforcement script
- Codebase analysis: Other WebSocket handlers (chat, terminal, dev-logs) -- use `@/backend/app-context`
- Codebase analysis: `git log --name-only main..HEAD` -- 230 files changed across feature branch

### Secondary (MEDIUM confidence)
- Phase 10 research and plans -- established the CI validation pattern used here
- Phase 17 verification report -- confirms all prior phases verified and complete

### Tertiary (LOW confidence)
- None -- all findings from direct codebase verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All tools already configured and verified working
- Architecture: HIGH -- Direct execution of all validation commands
- Pitfalls: HIGH -- Build failure identified through direct execution, root cause confirmed by comparing with sibling handler files
- Fix scope: HIGH -- Only 3 lines need changing, pattern established by 6 sibling files in same directory

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable -- no external dependencies or version concerns)
