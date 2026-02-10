# Roadmap: SRP Consolidation & Domain Module Refactor

**Created:** 2026-02-10
**Milestone:** v1 — Clean domain ownership across all core backend domains

## Overview

Refactor the flat `src/backend/services/` (45+ files) into domain modules under `src/backend/domains/`, following the pattern already emerging in `src/backend/domains/session/`. Each domain gets a self-contained module with co-located service logic, types, and tests. An orchestration layer handles cross-domain flows.

**Total phases:** 10
**Approach:** Big-bang restructure — all domains refactored, then wired together

## Phase 1: Foundation & Domain Scaffolding

**Goal:** Establish the domain module pattern, conventions, and directory scaffolding so subsequent phases have a clear target.

**Requirements:** DOM-01, DOM-02

**Plans:** 1 plan

Plans:
- [x] 01-01-PLAN.md — Create domain directories, barrel files, and dependency-cruiser cross-domain rule

**Delivers:**
- Domain module directory structure for all 6 domains (`session`, `workspace`, `github`, `ratchet`, `terminal`, `run-script`)
- Barrel file convention (`index.ts` per domain)
- Dependency-cruiser rule configuration to enforce no cross-domain imports
- Documented conventions for domain module structure

**Key files:**
- `src/backend/domains/session/` (already exists, extend)
- `src/backend/domains/workspace/` (new)
- `src/backend/domains/github/` (new)
- `src/backend/domains/ratchet/` (new)
- `src/backend/domains/terminal/` (new)
- `src/backend/domains/run-script/` (new)
- `.dependency-cruiser.cjs` (update rules)

**Success criteria:** `pnpm typecheck` passes, dependency-cruiser rules defined, all 6 domain directories exist with barrel files.

---

## Phase 2: Session Domain Consolidation

**Goal:** Consolidate all session-related logic into `src/backend/domains/session/` — the most scattered domain.

**Requirements:** SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, DOM-04

**Plans:** 6 plans

Plans:
- [x] 02-01-PLAN.md — Move claude/ types, constants, protocol layer, and refactor registry (DOM-04)
- [x] 02-02-PLAN.md — Move claude/ process, permissions, client, session, monitoring + barrel
- [x] 02-03-PLAN.md — Move session-store/ (13 files) to domains/session/store/
- [x] 02-04-PLAN.md — Move lifecycle services, data service, and file logger
- [x] 02-05-PLAN.md — Move chat services and chat-message-handlers/ (28 files)
- [x] 02-06-PLAN.md — Update session domain barrel and create domain smoke test

**Delivers:**
- Session lifecycle management (create, run, pause, resume, complete) in one module
- Claude process management (`src/backend/claude/`) absorbed into session domain
- Chat services (connection, forwarding, message handlers) absorbed into session domain
- Session file logging absorbed into session domain
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/session.service.ts` → domain
- `src/backend/services/session-data.service.ts` → domain
- `src/backend/services/session-file-logger.service.ts` → domain
- `src/backend/services/chat-connection.service.ts` → domain
- `src/backend/services/chat-event-forwarder.service.ts` → domain
- `src/backend/services/chat-message-handlers.service.ts` → domain
- `src/backend/claude/*` → domain (session management, process, protocol, permissions, registry, monitoring)
- `src/backend/domains/session/session-domain.service.ts` → stays, becomes core

**Success criteria:** All session operations flow through `src/backend/domains/session/`, existing session-related tests pass, new domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 3: Workspace Domain Consolidation

**Goal:** Consolidate all workspace-related logic into `src/backend/domains/workspace/`.

**Requirements:** WORK-01, WORK-02, WORK-03, WORK-04, WORK-05, DOM-04

**Plans:** 5 plans

Plans:
- [x] 03-01-PLAN.md — Move pure state functions (flow-state, kanban-state, init-policy) to state/
- [x] 03-02-PLAN.md — Move state machine, data, and activity services to lifecycle/
- [x] 03-03-PLAN.md — Move worktree-lifecycle to worktree/ with DOM-04 refactoring (3 globals)
- [x] 03-04-PLAN.md — Move creation and query services with DOM-04 refactoring (1 global)
- [x] 03-05-PLAN.md — Populate workspace domain barrel and create smoke test

**Delivers:**
- Workspace lifecycle (creation, state machine, archival) in one module
- Worktree management absorbed into workspace domain
- Kanban state derivation absorbed into workspace domain
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/workspace-creation.service.ts` → domain
- `src/backend/services/workspace-data.service.ts` → domain
- `src/backend/services/workspace-query.service.ts` → domain
- `src/backend/services/workspace-activity.service.ts` → domain
- `src/backend/services/workspace-flow-state.service.ts` → domain
- `src/backend/services/workspace-state-machine.service.ts` → domain
- `src/backend/services/worktree-lifecycle.service.ts` → domain
- `src/backend/services/kanban-state.service.ts` → domain
- `src/backend/services/workspace-init-policy.service.ts` → domain

**Success criteria:** All workspace operations flow through `src/backend/domains/workspace/`, existing workspace tests pass, new domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 4: GitHub Domain Consolidation

**Goal:** Consolidate GitHub CLI and PR-related services into `src/backend/domains/github/`.

**Requirements:** GH-01, GH-02, GH-03

**Plans:** 3 plans

Plans:
- [ ] 04-01-PLAN.md — Move github-cli and pr-snapshot services with tests to domain
- [ ] 04-02-PLAN.md — Move pr-review-fixer and pr-review-monitor services to domain
- [ ] 04-03-PLAN.md — Populate GitHub domain barrel and create smoke test

**Delivers:**
- GitHub CLI interactions (PRs, issues, CI status) in one module
- PR snapshot and review monitoring consolidated
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/github-cli.service.ts` → domain
- `src/backend/services/pr-snapshot.service.ts` → domain
- `src/backend/services/pr-review-monitor.service.ts` → domain
- `src/backend/services/pr-review-fixer.service.ts` → domain

**Success criteria:** All GitHub operations flow through `src/backend/domains/github/`, existing GitHub tests pass, new domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 5: Ratchet Domain Consolidation

**Goal:** Consolidate auto-fix and CI monitoring logic into `src/backend/domains/ratchet/`.

**Requirements:** RATCH-01, RATCH-02, RATCH-03

**Delivers:**
- Ratchet polling, CI monitoring, and auto-fix dispatch in one module
- CI fixer, fixer session creation consolidated
- Reconciliation logic consolidated
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/ratchet.service.ts` → domain
- `src/backend/services/ci-fixer.service.ts` → domain
- `src/backend/services/ci-monitor.service.ts` → domain
- `src/backend/services/fixer-session.service.ts` → domain
- `src/backend/services/reconciliation.service.ts` → domain

**Success criteria:** All ratchet operations flow through `src/backend/domains/ratchet/`, existing ratchet tests pass, new domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 6: Terminal Domain Consolidation

**Goal:** Consolidate terminal management into `src/backend/domains/terminal/`.

**Requirements:** TERM-01, TERM-02, TERM-03

**Plans:** 1 plan

Plans:
- [ ] 06-01-PLAN.md — Move terminal.service.ts to domain, create shim, barrel, and unit tests

**Delivers:**
- Terminal pty management, output buffering, monitoring in one module
- Static Maps replaced with instance-based state
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/terminal.service.ts` → domain

**Success criteria:** All terminal operations flow through `src/backend/domains/terminal/`, static Maps eliminated, domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 7: Run Script Domain Consolidation

**Goal:** Consolidate run script execution into `src/backend/domains/run-script/`.

**Requirements:** RS-01, RS-02, RS-03

**Delivers:**
- Run script execution, state machine, and startup scripts in one module
- Static Maps replaced with instance-based state
- Co-located unit tests covering the domain's public API

**Source files to consolidate:**
- `src/backend/services/run-script.service.ts` → domain
- `src/backend/services/run-script-state-machine.service.ts` → domain
- `src/backend/services/startup-script.service.ts` → domain

**Success criteria:** All run script operations flow through `src/backend/domains/run-script/`, static Maps eliminated, domain tests cover public API. `pnpm typecheck` passes.

---

## Phase 8: Orchestration Layer

**Goal:** Create explicit orchestration for flows that span multiple domains, replacing direct service-to-service calls.

**Requirements:** ORCH-01, ORCH-02, ORCH-03

**Delivers:**
- `src/backend/orchestration/` directory with flow orchestrators
- Workspace creation orchestration (workspace domain + session domain + worktree)
- Ratchet orchestration (GitHub domain + workspace domain + session domain for fixer)
- Any remaining cross-domain calls refactored through orchestration

**Key design:** Orchestrators import from domain barrel files only. Domains never import from each other — only orchestrators bridge them.

**Success criteria:** No direct cross-domain imports (domains don't import each other). Cross-domain flows are explicit and traceable. `pnpm typecheck` passes.

---

## Phase 9: AppContext & Import Rewiring

**Goal:** Update DI wiring and all import paths to use domain modules.

**Requirements:** WIRE-01, WIRE-02, WIRE-03, DOM-03

**Delivers:**
- `app-context.ts` updated to import from domain barrel files
- tRPC routers updated to import from domain barrel files
- WebSocket handlers updated to import from domain barrel files
- Old service files in `src/backend/services/` removed (domain-owned ones)
- Remaining infrastructure services stay in `src/backend/services/`

**Infrastructure services that stay in `src/backend/services/`:**
- `config.service.ts`, `logger.service.ts`, `scheduler.service.ts`
- `port.service.ts`, `port-allocation.service.ts`
- `server-instance.service.ts`, `rate-limiter.service.ts`
- `health.service.ts`, `cli-health.service.ts`
- `notification.service.ts`, `file-lock.service.ts`
- `data-backup.service.ts`, `factory-config.service.ts`
- `user-settings-query.service.ts`, `decision-log-query.service.ts`
- `project-management.service.ts`, `slash-command-cache.service.ts`

**Success criteria:** Dependency-cruiser validates no circular imports. No domain-owned files remain in `src/backend/services/`. `pnpm typecheck` passes.

---

## Phase 10: Validation & Stabilization

**Goal:** Verify the entire refactor is backward-compatible and the dependency graph is clean.

**Requirements:** WIRE-04, WIRE-05

**Delivers:**
- Full test suite passes (`pnpm test`)
- Type checking passes (`pnpm typecheck`)
- Linting passes (`pnpm check:fix`)
- Dependency-cruiser graph is clean (no violations)
- Smoke test: `pnpm dev` starts successfully
- Documentation of the new domain structure

**Success criteria:** All CI checks pass. Application starts and operates identically to pre-refactor. Import graph validated clean.

---

## Phase Dependencies

```
Phase 1 (Foundation) ─────────────────────────────────────┐
    │                                                       │
    ├── Phase 2 (Session) ──────────┐                       │
    ├── Phase 3 (Workspace) ────────┤                       │
    ├── Phase 4 (GitHub) ───────────┤                       │
    ├── Phase 5 (Ratchet) ──────────┼── Phase 8 (Orchestration) ── Phase 9 (Wiring) ── Phase 10 (Validation)
    ├── Phase 6 (Terminal) ─────────┤
    └── Phase 7 (Run Script) ──────┘
```

- Phase 1 must complete first (scaffolding)
- Phases 2-7 can run in parallel (independent domain consolidations)
- Phase 8 depends on all domain phases (2-7) completing
- Phase 9 depends on Phase 8
- Phase 10 depends on Phase 9

---
*Roadmap created: 2026-02-10*
*Last updated: 2026-02-10 — Phase 6 planned (1 plan, 1 wave, TERM-02 already satisfied)*
