# Codebase Concerns

**Analysis Date:** 2026-02-09

## Tech Debt

**Type Safety: 250+ instances of `any` types**
- Issue: 116 instances of `@ts-ignore` or type circumvention (casting with `as any`, `as unknown`) scattered across the codebase
- Files: `src/backend/claude/process.ts`, `src/backend/claude/permissions.ts`, `src/backend/claude/protocol.ts`, `src/backend/resource_accessors/`, `src/backend/services/`
- Impact: Silent type errors possible, harder to refactor safely, potential runtime bugs
- Fix approach: Gradual elimination - prioritize high-risk areas (database access, event handlers), use proper type definitions instead of castings, enable stricter tsconfig flags

**Large Monolithic Services**
- Issue: Multiple services exceed 900+ lines of code, making them difficult to test and maintain
- Files:
  - `src/backend/services/session-store.service.ts` (938 lines) - manages session state, hydration, replay events
  - `src/backend/services/chat-event-forwarder.service.ts` (983 lines) - event routing and interactive request handling
  - `src/backend/services/ratchet.service.ts` (959 lines) - PR state management and auto-fix dispatch
  - `src/backend/services/session.service.ts` - client lifecycle management
  - `src/backend/services/github-cli.service.ts` (1073 lines) - GitHub CLI wrapper with multiple schemas
- Impact: Cognitive load high, changes require understanding entire module, test coverage fragmented
- Fix approach: Extract focused concerns into separate services (e.g., SessionHydration, ReplayBuilder, PRStateValidator), use composition pattern, document responsibility boundaries

**Magic Numbers and Constants Scattered**
- Issue: Hard-coded values throughout codebase instead of centralized constants
- Examples: MAX_QUEUE_SIZE=100 (`session-store.service.ts`), RATCHET_POLL_INTERVAL_MS=60_000, SPAWN_TIMEOUT=30_000, MAX_FILE_SIZE=1MB
- Files: `src/backend/services/`, `src/backend/lib/`, `src/backend/claude/`
- Impact: Difficult to tune performance, inconsistent naming, hard to find where values are used
- Fix approach: Create `constants.ts` files per domain, centralize thresholds and timeouts, document why each value was chosen

**Console Logging (81 instances)**
- Issue: 81 instances of `console.*` calls bypass proper logging infrastructure
- Files: scattered across `src/` backend and components
- Impact: No log levels, no formatting, cannot be controlled or filtered in production
- Fix approach: Replace all with `createLogger()` service, define minimum log levels per module

## Concurrency & Race Conditions

**File-Based Advisory Locks: Single-Process Only**
- Issue: `src/backend/services/file-lock.service.ts` maintains in-memory lock state that is not shared across multiple Node.js processes
- Files: `src/backend/services/file-lock.service.ts` (lines 11-16), used by `src/backend/routers/mcp/lock.mcp.ts`
- Impact: In a multi-process deployment (clustering, load balancing), lock coordination fails; multiple processes could simultaneously modify the same files; file persistence helps on restart but not during runtime
- Current mitigation: TTL-based expiration (30 minutes) and file-based persistence provide partial recovery
- Recommendations: Document single-process constraint clearly; if clustering required, migrate to distributed lock (Redis, database-based); add startup warning if cluster mode detected

**Ratchet State Progression Race**
- Issue: `src/backend/services/ratchet.service.ts` polls workspace PR state and dispatches fixer sessions, but state transitions between polling intervals can race (e.g., CI finishes, then review posted before ratchet checks)
- Files: `src/backend/services/ratchet.service.ts` (lines 97-178 - start/check loop)
- Impact: May dispatch redundant fixer sessions, or miss important state transitions; snapshot key logic attempts to mitigate but not foolproof
- Current approach: Tracks `prCiLastNotifiedAt`, `prReviewLastCheckedAt`, `ratchetLastCiRunId` to detect changes
- Recommendations: Add transaction-like semantics around PR state fetch + dispatch decision; consider event-driven updates instead of polling; document race windows clearly

**Session Hydration State Machine**
- Issue: `src/backend/services/session-store.service.ts` (lines 540-600) manages hydration with generation tracking, but concurrent subscribe/unsubscribe patterns could miss state transitions
- Files: `src/backend/services/session-store.service.ts` (ensureHydrated method)
- Impact: Stale transcript could be served if rehydration timing aligns with replay emission
- Current approach: Tracks `hydratingKey`, `hydratedKey`, `hydrateGeneration` with promise-based synchronization
- Recommendations: Ensure lock-free guarantees; add explicit testing for concurrent hydration scenarios; consider mutex-like semantics

**ClaudeProcess Lifecycle Management**
- Issue: `src/backend/claude/process.ts` spawns and monitors Claude CLI process with signal handling and cleanup, but rapid stop/start could leak processes
- Files: `src/backend/claude/process.ts` (lines 97-160), `src/backend/services/session.process-manager.ts`
- Impact: Orphaned Claude processes consuming resources, potential file descriptor leaks, race between `isStopInProgress` checks and actual stop
- Current approach: Uses `isStopInProgress` flag and process registration
- Recommendations: Add strict lifecycle state machine (IDLE → SPAWNING → RUNNING → STOPPING → STOPPED); use atomic operations for transitions; add forced timeout for cleanup

## Security Considerations

**Shell Command Escaping Trust Boundary**
- Issue: `src/backend/lib/shell.ts` implements `escapeShellArg()` for safe command construction, but many call sites don't consistently use it
- Files: `src/backend/lib/shell.ts`, `src/backend/lib/shell.ts` (lines 40-66), usage in git operations, terminal commands
- Risk: Command injection if untrusted input (branch names, file paths, session names) bypasses escaping
- Current validation: Branch name validation (`isValidBranchName`), session name validation (`isValidSessionName`)
- Recommendations:
  - Audit all shell.ts usage sites - ensure untrusted inputs always go through validation functions
  - Add TSLint rule to prevent direct use of `execFile` outside of `shell.ts`
  - Document which inputs are untrusted (workspace names from GitHub API, user file paths, etc.)

**GitHub CLI Integration with Shell Execution**
- Issue: `src/backend/services/github-cli.service.ts` (1073 lines) wraps `gh` CLI with JSON response parsing, but depends on local gh auth
- Files: `src/backend/services/github-cli.service.ts` (lines 1-50, schema definitions)
- Risk: If `gh` binary is missing or auth is stale, API calls fail silently or with unclear errors
- Current approach: Uses Zod schema validation on gh JSON output
- Recommendations:
  - Add pre-flight check for gh binary availability and auth status
  - Implement gh auth refresh logic
  - Document gh CLI version requirements
  - Provide clear error messages when gh is misconfigured

**Configuration via Environment Variables**
- Issue: Database path controlled by `DATABASE_PATH` or `BASE_DIR` env var, no encryption for `.env` file
- Files: `src/backend/services/config.service.ts`, `.env` file (not committed)
- Risk: Database file path exposure, SQLite file not encrypted at rest
- Current approach: Default to `~/factory-factory/data.db`
- Recommendations:
  - Document that `.env` should never be committed
  - Consider requiring encryption for prod deployments (SQLCipher)
  - Document what secrets go in .env (if any)

**Missing Input Validation on Tool Inputs**
- Issue: `src/backend/schemas/tool-inputs.schema.ts` defines Zod schemas but parsing failures could leave invalid state
- Files: `src/backend/schemas/tool-inputs.schema.ts`, used in `src/backend/services/chat-event-forwarder.service.ts` (safeParseToolInput)
- Risk: Invalid tool input passed to Claude could cause unexpected behavior
- Current approach: `safeParseToolInput` function handles parse errors
- Recommendations: Log failed validations for monitoring, document which tool inputs are most critical

## Performance Bottlenecks

**Session Store In-Memory Transcript with No Size Limit**
- Problem: `src/backend/services/session-store.service.ts` keeps entire transcript in memory; no explicit limit on queue size (MAX_QUEUE_SIZE=100)
- Files: `src/backend/services/session-store.service.ts` (lines 30-46, SessionStore interface)
- Cause: All messages (user + Claude) accumulated without pruning; rehydration from JSONL adds to memory
- Scale limit: Long-running sessions (>1000 messages) could consume significant heap
- Improvement path:
  - Implement message pruning strategy (keep last N messages in memory, rest in JSONL)
  - Add memory usage monitoring (already in `src/backend/claude/monitoring.ts` for processes)
  - Consider streaming large transcripts rather than full load on subscribe
  - Profile with real workload data

**Ratchet Polling Interval**
- Problem: RATCHET_POLL_INTERVAL_MS = 60_000 (1 minute) means 1-minute delay before detecting PR state changes
- Files: `src/backend/services/ratchet.service.ts` (line 23)
- Cause: Polling strategy instead of event-driven
- Scale limit: With N workspaces, becomes N polling calls per minute; scales linearly with workspace count
- Improvement path:
  - Add GitHub webhook support for push/PR events
  - Reduce polling interval for high-priority PRs (failing CI)
  - Add exponential backoff for inactive PRs
  - Implement caching to avoid redundant GitHub API calls

**GitHub CLI Output Parsing**
- Problem: `github-cli.service.ts` spawns `gh` CLI for each query; no batch operations or caching
- Files: `src/backend/services/github-cli.service.ts`
- Cause: One `execFile` call per API method; Zod schema validation on every response
- Scale limit: With N workspaces with PRs, becomes N * polling_frequency calls to gh
- Improvement path:
  - Cache PR state for configured TTL (5-10 minutes)
  - Batch workspace PR checks in single command
  - Use gh GraphQL API directly for complex queries
  - Add circuit breaker for gh command failures

**File Lock Persistence**
- Problem: `src/backend/services/file-lock.service.ts` reads/writes `advisory-locks.json` file on every lock operation
- Files: `src/backend/services/file-lock.service.ts` (lines 76-100)
- Cause: Synchronous file I/O for lock state durability
- Scale limit: With many concurrent lock operations, file I/O becomes bottleneck
- Improvement path:
  - Batch persistence writes (write every N seconds instead of per-operation)
  - Use in-memory-only mode for non-durable workloads
  - Migrate to database-backed locks if cross-process support needed

**Session Store Hydration on Every Subscribe**
- Problem: `ensureHydrated()` in session-store.service.ts reads JSONL file from disk every subscribe
- Files: `src/backend/services/session-store.service.ts` (lines 540-600)
- Cause: No in-memory cache of hydrated sessions; generational checking adds complexity
- Scale limit: Repeated subscribes to same session cause redundant disk reads
- Improvement path:
  - Cache hydrated sessions in memory with TTL
  - Lazy hydration (defer until first message request)
  - Pre-warm cache on session creation

## Fragile Areas

**Chat Event Forwarder: Interdependent Event Routing**
- Files: `src/backend/services/chat-event-forwarder.service.ts` (983 lines)
- Why fragile:
  - Routes events from ClaudeClient → WebSocket → React UI state
  - Multiple message types (user, claude, streaming, interactive) with overlapping handlers
  - Pending interactive requests (AskUserQuestion, permissions) stored in-memory
  - State recovery from JSONL requires exact message order and type matching
- Safe modification:
  - Add comprehensive logging before changing event flow
  - Test with recorded session replays
  - Document state transition diagram
- Test coverage gaps:
  - No tests for interrupted sessions (process crash mid-message)
  - Limited testing of permission request lifecycle
  - No chaos testing for WebSocket reconnections during streaming

**Workspace State Machine Transitions**
- Files: `src/backend/services/workspace-state-machine.service.ts`, `src/backend/services/worktree-lifecycle.service.ts` (785 lines)
- Why fragile:
  - Multiple async operations (git worktree creation, startup script, run script) can fail independently
  - State transitions from NEW → PROVISIONING → READY depend on all scripts succeeding
  - Retry logic and stale state detection (STALE_PROVISIONING_THRESHOLD_MS = 10 minutes) could conflict
  - Resume mode tracking (`writResumeModes` function) persists to JSON, concurrent writes could corrupt
- Safe modification:
  - Never modify state directly; always go through state machine
  - Test failure scenarios (network loss, script timeout, disk full)
  - Add state transition logging
- Test coverage gaps:
  - No tests for resume mode file corruption recovery
  - Limited concurrency tests for simultaneous workspace creation
  - No tests for mid-initialization failure recovery

**Claude Protocol NDJSON Parsing**
- Files: `src/backend/claude/protocol.ts` (718 lines), `src/backend/claude/types.ts` (991 lines)
- Why fragile:
  - readline.Interface processes stdin line-by-line; max line length (1MB default) prevents DoS but truncates legitimately large messages
  - Zod validation validates structure but doesn't catch semantic errors (e.g., invalid sessionId format)
  - PendingRequest tracking uses `unknown` for responses, relies on runtime validation (lines 45-52)
  - Timeout handling with NodeJS.Timeout could leak if promise rejected before timeout cleared
- Safe modification:
  - Never bypass Zod validation for "efficiency"
  - Test with pathological inputs (max-length lines, invalid JSON)
  - Document protocol versioning strategy
- Test coverage gaps:
  - No tests for max line length truncation scenarios
  - Limited error recovery tests (stdin closed, stdout pipe broken)
  - No tests for timeout edge cases

## Scaling Limits

**In-Memory Session Store**
- Current capacity: Depends on node heap size; no explicit limit
- Limit: Will crash if total transcript + queue size exceeds available heap (default ~1.4GB on 64-bit Node)
- Scaling path:
  - Implement transcript pagination (load chunks on demand)
  - Stream large transcripts to client instead of buffering
  - Move cold sessions to disk cache
  - Add memory pressure alarms

**Claude Process Registry**
- Current capacity: Single global map in memory (`src/backend/claude/registry.ts`)
- Limit: No explicit limit on concurrent processes; resource monitoring has 10GB memory limit per process
- Scaling path:
  - Add hard limit on concurrent processes (prevent runaway spawning)
  - Implement process prioritization (FIFO eviction or LRU)
  - Add queuing for process spawn requests
  - Monitor actual resource usage against limits

**File Lock Storage**
- Current capacity: In-memory Map per workspace, persisted to JSON file
- Limit: File I/O becomes bottleneck with >1000 locks per workspace
- Scaling path:
  - Migrate to SQLite backend for locks
  - Implement lock cleanup more aggressively
  - Add batch operations for bulk lock operations

**Database Queries**
- Issue: No explicit query performance analysis; Prisma client used with no indexing documentation beyond schema comments
- Files: `prisma/schema.prisma` (indexes defined but not documented for performance)
- Scaling path:
  - Add query monitoring / slow query logging
  - Benchmark N+1 scenarios (workspace → sessions → messages)
  - Document query patterns for future maintainers
  - Profile on realistic data volumes (1000+ workspaces)

## Dependencies at Risk

**GitHub CLI (gh) Dependency**
- Risk: External binary dependency; version not pinned in codebase, no version check at runtime
- Impact: If gh is missing or version incompatible, GitHub operations silently fail or behave unexpectedly
- Migration plan:
  - Switch to Octokit.js library (npm package, more portable)
  - Implement proper version checking at startup
  - Add fallback to REST API if gh command fails

**Claude CLI (claude) Process**
- Risk: Spawned as external process; no version pinning, process lifecycle not fully isolated
- Impact: If Claude CLI crashes, session state could become stale; rapid restarts could DOS system resources
- Migration plan:
  - Implement strict rate limiting on Claude process respawn
  - Add health checks to detect crashed processes
  - Consider bundling Claude CLI version with app

**SQLite Database**
- Risk: Single file at `~/factory-factory/data.db`; no backup strategy enforced
- Impact: Data loss if file corrupted or storage fails; no WAL (write-ahead logging) mentioned
- Migration plan:
  - Enable WAL mode in Prisma config for durability
  - Add scheduled backup to separate storage
  - Implement data export/import for migrations

## Test Coverage Gaps

**Session Recovery from Process Crash**
- What's not tested: Process exits unexpectedly mid-message; session store must recover from JSONL without data loss
- Files: `src/backend/services/session-store.service.ts`, `src/backend/services/chat-event-forwarder.service.ts`
- Risk: If JSONL reading fails or is partially written, session could be lost or corrupted
- Priority: **High** - affects data integrity

**Concurrent Workspace Operations**
- What's not tested: Multiple simultaneous workspace creation/deletion, git operations on same project
- Files: `src/backend/services/worktree-lifecycle.service.ts`, `src/backend/services/git-ops.service.ts`
- Risk: Race conditions could corrupt git state or leave orphaned worktrees
- Priority: **High** - affects workspace reliability

**GitHub API Error Handling**
- What's not tested: gh command failures, GitHub API rate limiting, network timeouts
- Files: `src/backend/services/github-cli.service.ts`
- Risk: Silent failures or cascading errors when GitHub is down
- Priority: **Medium** - degrades gracefully but with poor UX

**Terminal Session Lifecycle**
- What's not tested: Rapid terminal close/reopen, TTY resize during process, SIGINT handling
- Files: `src/backend/routers/websocket/terminal.handler.ts`
- Risk: Terminal could become unresponsive or leak process resources
- Priority: **Medium** - affects terminal reliability

**Interactive Requests (Permissions/Questions)**
- What's not tested: User never responds to permission prompt, timeout behavior, session disconnect during request
- Files: `src/backend/services/chat-event-forwarder.service.ts`, `src/backend/services/chat-message-handlers/handlers/permission-response.handler.ts`
- Risk: Session could hang indefinitely waiting for response
- Priority: **Medium** - affects user experience

## Complexity Hotspots

**Session Lifecycle State Coordination**
- Multiple state sources: ClaudeSession DB status, in-memory ClaudeProcess state, ratchet active session ID, session store hydration state
- Challenge: Keeping these in sync requires careful ordering of operations
- Files: `src/backend/services/session.service.ts`, `src/backend/domains/session/session-domain.service.ts`
- Recommendation: Document authoritative state source for each query

**Message Order and Reconciliation**
- Problem: Messages have order field for sorting, but rehydration from JSONL must maintain order; queue operations (dequeue, requeue, remove) modify order
- Files: `src/backend/services/session-store.service.ts` (messageSort function), chat reducer
- Recommendation: Use append-only log semantics; order should never change for persisted messages

**Interceptor Chain**
- Problem: Multiple interceptors modify messages (conversation-rename, branch-rename, pr-detection) in sequence; ordering matters
- Files: `src/backend/interceptors/`, `src/backend/interceptors/registry.ts`
- Recommendation: Document interceptor ordering contract, add explicit ordering in registry

---

*Concerns audit: 2026-02-09*
