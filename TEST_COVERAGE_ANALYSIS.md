# Test Coverage Analysis

**Date:** 2026-02-11
**Overall Coverage:** 50.5% statements, 43.1% branches, 48.5% functions, 50.7% lines
**Test Suite:** 109 test files, 2056 passing tests

---

## Executive Summary

The codebase has solid test coverage in domain logic (session store, orchestration, middleware) but significant gaps in the API layer, database accessors, message handlers, and infrastructure services. The overall 50% line coverage is pulled down by several critical modules at 0%.

**Strongest areas:** orchestration (~89%), session store (~86%), terminal domain (~86%), middleware (100%), schemas (100%)
**Weakest areas:** tRPC routers (0%), resource accessors (~17%), CLI (0%), chat message handlers (~17%), several infrastructure services (<20%)

---

## Coverage Gaps Ranked by Priority

### 1. tRPC Routers — 0% coverage (CRITICAL)

**Files:** `src/backend/trpc/` — admin, github, session, workspace, project, pr-review, user-settings, decision-log routers (~2000 lines total)

**Current state:** Two test files exist (`project.trpc.test.ts`, `workspace.trpc.test.ts`) but they only test helper parsing functions (`parseGitStatusOutput`, `parseGitHubRemoteUrl`), not actual tRPC endpoints. Every router procedure is untested.

**Why it matters:** These are the primary API endpoints consumed by the frontend. Bugs here silently break the entire UI. Input validation, authorization, error formatting, and response shapes are all unverified.

**Recommended tests:**
- Test each router procedure with valid inputs against a test database
- Test input validation rejects malformed requests (Zod schema enforcement)
- Test error cases (missing resources, invalid state transitions)
- Priority files: `workspace.trpc.ts` (218 lines, complex state transitions), `session.trpc.ts` (212 lines, session lifecycle), `admin.trpc.ts` (472 lines, most complex)

---

### 2. Resource Accessors — ~17% coverage (CRITICAL)

**Files:** `src/backend/resource_accessors/` — workspace (657 lines), project (318 lines), claude-session (169 lines), terminal-session (103 lines), decision-log, user-settings, data-backup

**Current state:** Existing tests only cover URL parsing helpers. No tests exercise actual Prisma queries or database interactions. `workspace.accessor.ts` is the largest at 657 lines with complex filtered queries, PR tracking, ratchet state management, and archival logic.

**Why it matters:** This is the database access layer. Incorrect queries corrupt data, lose state, or return wrong results. The workspace accessor handles ~20 different query patterns including status-dependent filtering.

**Recommended tests:**
- Integration tests using an in-memory SQLite database or test fixtures
- Test each accessor method with expected database state
- Verify workspace status transitions, PR field updates, archival/recovery
- Priority: `workspace.accessor.ts` (most complex, most critical)

---

### 3. Chat Message Handlers — 3-17% coverage (HIGH)

**Files:** `src/backend/domains/session/chat/chat-message-handlers/handlers/` — 13 handler files, only `start.handler.test.ts` exists (1 test case)

**Untested handlers:** cancel, pause, resume, user-input, queue-message, load-session, list-sessions, rewind-files, permission-response, question-response, remove-queued-message, set-model, set-thinking-budget

**Why it matters:** These are the core WebSocket message handlers that drive all user interaction with Claude sessions. They manage message queuing, state transitions, file rewinding (checkpoint-based), and process communication. Bugs here affect every user session.

**Recommended tests:**
- Test each handler's happy path with mocked session state
- Test error handling (missing session, invalid state for operation)
- Test `queue-message.handler.ts` (3.4KB, most complex) — queue overflow, ordering
- Test `load-session.handler.ts` (2.5KB) — state restoration correctness
- Test `rewind-files.handler.ts` (2.1KB) — checkpoint logic

---

### 4. Chat Event Forwarder — 27% coverage (HIGH)

**File:** `src/backend/domains/session/chat/chat-event-forwarder.service.ts` (~1000 lines)

**Current state:** This is the largest chat service file, handling event forwarding from Claude processes to WebSocket clients. At 27% coverage, most of its event handling paths are untested.

**Why it matters:** Incorrect event forwarding can cause lost messages, out-of-order updates, or stale UI state. This is the bridge between the Claude CLI process and the frontend.

**Recommended tests:**
- Test each event type forwarding (tool_use, message, result, error, exit)
- Test reconnection/replay behavior
- Test event filtering and transformation logic

---

### 5. CLI Module — 0% coverage (HIGH)

**Files:** `src/cli/index.ts` (781 lines) — zero test files

**What it does:** Server startup, port resolution, process spawning (dev/prod modes), database migration execution, graceful shutdown with SIGTERM/SIGKILL, environment setup.

**Why it matters:** Bugs in startup logic prevent the app from running at all. Port conflict resolution, process lifecycle, and migration ordering are all critical paths tested only through manual usage.

**Recommended tests:**
- Extract pure logic into testable functions: port-finding algorithm, environment variable resolution, migration ordering
- Test shutdown signal handling with mock processes
- Test dev vs production mode configuration differences

---

### 6. Infrastructure Services — 0-19% coverage (HIGH)

| Service | Lines | Coverage | Purpose |
|---------|-------|----------|---------|
| `notification.service.ts` | 352 | 4.5% | Desktop notifications with platform-specific shell commands, quiet hours |
| `session.service.ts` | ~600 | 14% | Session options, client creation, heartbeat monitoring |
| `scheduler.service.ts` | 240 | 17% | PR status sync scheduler with concurrency limits |
| `health.service.ts` | 105 | 19% | System health aggregation |
| `snapshot-cache.service.ts` | 100 | 4% | In-memory caching for workspace snapshots |

**Why it matters:**
- `notification.service.ts` executes platform-specific shell commands (osascript, notify-send, PowerShell) — potential command injection risk if inputs are not sanitized. Quiet-hours logic has edge cases (overnight ranges).
- `session.service.ts` manages process lifecycle — crashes here leak child processes.
- `scheduler.service.ts` runs background jobs — failures are silent without tests.

**Recommended tests:**
- `notification.service`: Test quiet-hours boundary logic, test that user inputs are properly escaped before shell execution
- `scheduler.service`: Test concurrency limits, graceful shutdown with in-flight tasks, error handling for individual batch failures
- `session.service`: Test client creation, heartbeat timeout behavior, cleanup on process exit

---

### 7. Process Adapter (Agents) — 0% coverage (HIGH)

**File:** `src/backend/agents/process-adapter.ts` (365 lines)

**What it does:** Bridge between agent IDs and Claude CLI process instances. Manages process lifecycle (start/stop/kill), event forwarding with agentId tagging, statistics collection, cleanup on exit.

**Why it matters:** This is the core of the multi-agent orchestration infrastructure. Resource leaks here mean orphaned Claude processes consuming system resources. Event propagation bugs cause UI to show stale agent state.

**Recommended tests:**
- Test agent lifecycle (start → running → stop → cleaned up)
- Test event forwarding attaches correct agentId
- Test cleanup kills all tracked processes
- Test concurrent agent management

---

### 8. Middleware Interceptors — 12% coverage (MEDIUM)

**Files:** `src/backend/middleware/interceptors/` — CORS, security headers, request logging

**Why it matters:** Security headers and CORS validation are production requirements. Current tests don't verify that headers are actually set correctly on responses.

**Recommended tests:**
- Integration tests that make HTTP requests and assert response headers
- CORS whitelist validation (allowed origin accepted, unknown origin rejected)
- Security headers present on all responses

---

### 9. Client Routes & Components — <1% coverage (MEDIUM)

**Current state:** 14 frontend test files exist but focus on state management (reducers, hooks, persistence). Zero tests for route-level React components. Only `resume-workspace-storage.test.ts` exists under `src/client/routes/`.

**Why it matters:** Frontend regressions are caught only through manual testing. Complex components like workspace detail, chat interface, and admin dashboard have no automated coverage.

**Recommended tests:**
- Component render tests with React Testing Library for key pages
- Priority: workspace detail view (most complex), session chat UI, project list
- Test error boundaries and loading states
- Note: Storybook stories (per AGENTS.md guidelines) may partially address this — verify story coverage first

---

### 10. Workspace Query Service — 6.5% coverage (MEDIUM)

**File:** `src/backend/domains/workspace/query/query.service.ts` (~400 lines)

**What it does:** Complex workspace query logic including filtering by status, aggregating session data, computing derived kanban state.

**Why it matters:** The Kanban board depends on correct derived state from this service. Incorrect queries show workspaces in wrong columns or hide them entirely.

**Recommended tests:**
- Test each query method with different workspace states
- Test kanban column derivation logic
- Test edge cases: archived workspaces, workspaces with no sessions

---

## What's Working Well

These areas have strong coverage and serve as good examples of the testing patterns to follow:

| Area | Coverage | Notes |
|------|----------|-------|
| Orchestration layer | 89% | Good integration tests with mocked domain bridges |
| Session store | 86% | Thorough state machine and transcript tests |
| Terminal domain | 86% | Good service-level coverage |
| Middleware | 100% | Clean unit tests per middleware function |
| Schemas | 100% | Zod schema validation tested |
| Backend utils | 100% | Pure function tests |
| Rate-limit backoff | 100% | Algorithm thoroughly tested |
| File-lock service | 95% | Concurrency edge cases covered |

---

## Suggested Approach

1. **Start with tRPC routers** — highest impact per test written since they validate the entire API contract
2. **Add integration tests for resource accessors** — set up a shared test database fixture pattern
3. **Cover the 12 untested message handlers** — these are small files (~1-3KB each) and quick wins
4. **Extract testable logic from CLI** — refactor pure functions out of the monolithic 781-line file
5. **Add security-focused tests for notification service** — verify shell command escaping
6. **Add component tests for critical UI paths** — workspace detail and chat views
