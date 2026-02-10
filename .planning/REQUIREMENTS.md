# Requirements: SRP Consolidation & Domain Module Refactor

**Defined:** 2026-02-10
**Core Value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## v1 Requirements

### Domain Module Structure

- [ ] **DOM-01**: Each core domain lives in `src/backend/domains/{name}/` with co-located service, types, and tests
- [ ] **DOM-02**: Each domain module exports a single public API via barrel file (`index.ts`)
- [ ] **DOM-03**: Domain modules depend downward (on accessors, shared, infra) but never import from each other
- [ ] **DOM-04**: Static Maps and class-level global state eliminated from all domain modules — use instance-based services

### Session Domain

- [ ] **SESS-01**: `src/backend/domains/session/` owns all session lifecycle logic (create, run, pause, resume, complete)
- [ ] **SESS-02**: Claude process management (`src/backend/claude/`) consolidated under session domain
- [ ] **SESS-03**: Chat connection, event forwarding, and message dispatch consolidated under session domain
- [ ] **SESS-04**: Session file logging consolidated under session domain
- [ ] **SESS-05**: Session domain has co-located unit tests covering its public API

### Workspace Domain

- [ ] **WORK-01**: `src/backend/domains/workspace/` owns all workspace lifecycle logic (creation, state machine, archival, query)
- [ ] **WORK-02**: Worktree lifecycle management consolidated under workspace domain
- [ ] **WORK-03**: Kanban state derivation consolidated under workspace domain
- [ ] **WORK-04**: Workspace flow state and activity tracking consolidated under workspace domain
- [ ] **WORK-05**: Workspace domain has co-located unit tests covering its public API

### GitHub Domain

- [ ] **GH-01**: `src/backend/domains/github/` owns all GitHub CLI interactions (PRs, issues, CI status)
- [ ] **GH-02**: PR snapshot and review monitoring consolidated under GitHub domain
- [ ] **GH-03**: GitHub domain has co-located unit tests covering its public API

### Ratchet Domain

- [ ] **RATCH-01**: `src/backend/domains/ratchet/` owns all auto-fix logic (CI monitoring, fixer sessions, reconciliation)
- [ ] **RATCH-02**: CI fixer, CI monitor, and PR review fixer consolidated under ratchet domain
- [ ] **RATCH-03**: Ratchet domain has co-located unit tests covering its public API

### Terminal Domain

- [ ] **TERM-01**: `src/backend/domains/terminal/` owns terminal pty management, output buffering, and monitoring
- [ ] **TERM-02**: Static Maps in terminal service replaced with instance-based state
- [ ] **TERM-03**: Terminal domain has co-located unit tests covering its public API

### Run Script Domain

- [ ] **RS-01**: `src/backend/domains/run-script/` owns run script execution, state machine, and startup scripts
- [ ] **RS-02**: Static Maps in run script service replaced with instance-based state
- [ ] **RS-03**: Run script domain has co-located unit tests covering its public API

### Orchestration

- [ ] **ORCH-01**: Cross-domain flows use an explicit orchestration layer rather than direct service-to-service calls
- [ ] **ORCH-02**: Workspace creation flow (workspace + worktree + optional session) is a single traceable orchestration
- [ ] **ORCH-03**: Ratchet flow (GitHub check + workspace state update + fixer session creation) is a single traceable orchestration

### Wiring & Validation

- [ ] **WIRE-01**: `app-context.ts` references domain modules instead of individual services
- [ ] **WIRE-02**: tRPC routers import from domain module barrel files, not individual service files
- [ ] **WIRE-03**: No circular imports in the dependency graph (validated by dependency-cruiser)
- [ ] **WIRE-04**: All existing tRPC endpoints continue to work identically (backward compatible)
- [ ] **WIRE-05**: All existing tests pass after refactor

## v2 Requirements

### Integration Testing

- **INT-01**: Integration tests for cross-domain orchestration flows
- **INT-02**: Integration tests for session lifecycle with mocked Claude process

### Advanced Domain Patterns

- **ADV-01**: Domain events for loose coupling between domains
- **ADV-02**: Command/query separation within domain modules

## Out of Scope

| Feature | Reason |
|---------|--------|
| Frontend refactoring | Backend-only project |
| New features | Purely structural refactor |
| Database schema changes | Prisma models stay as-is |
| Performance optimization | Not a goal unless it falls out naturally |
| Auth system changes | No auth changes |
| Resource accessor refactoring | Already clean abstraction |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DOM-01 | Phase 1 | Pending |
| DOM-02 | Phase 1 | Pending |
| DOM-03 | Phase 9 | Pending |
| DOM-04 | Phases 2-7 | Pending |
| SESS-01 | Phase 2 | Pending |
| SESS-02 | Phase 2 | Pending |
| SESS-03 | Phase 2 | Pending |
| SESS-04 | Phase 2 | Pending |
| SESS-05 | Phase 2 | Pending |
| WORK-01 | Phase 3 | Pending |
| WORK-02 | Phase 3 | Pending |
| WORK-03 | Phase 3 | Pending |
| WORK-04 | Phase 3 | Pending |
| WORK-05 | Phase 3 | Pending |
| GH-01 | Phase 4 | Pending |
| GH-02 | Phase 4 | Pending |
| GH-03 | Phase 4 | Pending |
| RATCH-01 | Phase 5 | Pending |
| RATCH-02 | Phase 5 | Pending |
| RATCH-03 | Phase 5 | Pending |
| TERM-01 | Phase 6 | Pending |
| TERM-02 | Phase 6 | Pending |
| TERM-03 | Phase 6 | Pending |
| RS-01 | Phase 7 | Pending |
| RS-02 | Phase 7 | Pending |
| RS-03 | Phase 7 | Pending |
| ORCH-01 | Phase 8 | Pending |
| ORCH-02 | Phase 8 | Pending |
| ORCH-03 | Phase 8 | Pending |
| WIRE-01 | Phase 9 | Pending |
| WIRE-02 | Phase 9 | Pending |
| WIRE-03 | Phase 9 | Pending |
| WIRE-04 | Phase 10 | Pending |
| WIRE-05 | Phase 10 | Pending |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0

---
*Requirements defined: 2026-02-10*
*Last updated: 2026-02-10 after initial definition*
