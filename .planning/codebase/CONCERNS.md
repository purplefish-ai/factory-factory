# Codebase Concerns

**Analysis Date:** 2026-02-09

## Tech Debt

**File-Lock Service: Single-Process Limitation**
- Issue: The advisory file locking system is in-memory only and not shared across multiple Node.js processes. File persistence helps on restart but provides no cross-process synchronization during runtime.
- Files: `src/backend/services/file-lock.service.ts` (lines 12-16)
- Impact: In clustered or multi-process deployments, multiple processes can acquire the same lock simultaneously, leading to race conditions and file trampling
- Fix approach: Implement file-based exclusive locking using flock() or atomic file operations, or introduce a centralized lock server for distributed scenarios

**Resume Modes Serialization: Race Condition on File Write**
- Issue: `writeResumeModes()` writes JSON directly without atomic operations. Concurrent calls to `updateResumeModes()` on the same worktree can cause data loss if writes overlap.
- Files: `src/backend/services/worktree-lifecycle.service.ts` (lines 78-98)
- Impact: Resume mode state can be lost during concurrent workspace initializations, preventing correct branch selection on resume
- Fix approach: Implement atomic file writes using temporary file + rename pattern, or add file-level locking around the entire read-modify-write cycle

**Session Store Hydration Logic Complexity**
- Issue: Complex hydration generation tracking with potential race conditions. `hydrateGeneration` field and multiple concurrent hydration guards could miss state updates.
- Files: `src/backend/services/session-store.service.ts` (lines 31-46, 114-136)
- Impact: Session state may not properly hydrate from database during rapid state changes, causing message loss or duplicate processing
- Fix approach: Simplify by using a single mutual-exclusion pattern (e.g., async lock) rather than generation numbers. Consider queue-based hydration instead of concurrent attempts.

**Chat WebSocket Event Forwarding: Potential Event Loss**
- Issue: Event listeners are registered during client setup but cleanup happens on client exit. If listeners fail to register or client crashes before exit handler, events may be silently dropped.
- Files: `src/backend/services/chat-event-forwarder.service.ts` (lines 180-225, 500-504)
- Impact: User won't see tool outputs or Claude responses if the event forwarding listener crashes without notification
- Fix approach: Add try-catch around each listener registration with explicit error logging. Implement health check for listener attachment and re-attach on failure.

**GitHub CLI Service: 10MB Diff Buffer Fixed Limit**
- Issue: `GH_MAX_BUFFER_BYTES.diff` is hardcoded to 10MB. Large diffs in monorepos or complex PRs will be truncated silently.
- Files: `src/backend/services/github-cli.service.ts` (lines 27-29)
- Impact: PR diffs larger than 10MB are silently truncated, causing incomplete code review and incorrect PR analysis
- Fix approach: Stream large diffs instead of buffering, or increase limit with degradation warnings. Implement chunked processing for very large diffs.

**Service Loop Shutdown Timing**
- Issue: Multiple services (`SchedulerService`, `RatchetService`) use `isShuttingDown` flag but may still be executing operations during shutdown window.
- Files: `src/backend/services/scheduler.service.ts` (lines 57-71), `src/backend/services/ratchet.service.ts` (lines 106-116)
- Impact: Operations may be dropped or partially executed during server shutdown, leading to incomplete ratchet dispatches or missed PR syncs
- Fix approach: Add graceful shutdown window where new operations are rejected but in-flight operations complete. Use Promise.allSettled() to ensure cleanup of all pending work.

**Session Store: Message Ordering Dependencies**
- Issue: `nextOrder` counter increments without atomicity guarantee. Multiple concurrent message enqueues could produce duplicate order values.
- Files: `src/backend/services/session-store.service.ts` (lines 44, 400-450)
- Impact: Messages may be processed out of order or cause UI rendering issues when order values collide
- Fix approach: Use a Mutex/lock around all order allocation, or switch to UUID-based ordering with client-side sorting

---

## Known Bugs

**Resume Mode Validation Silently Fails**
- Symptoms: Resume mode preference set by user is ignored on workspace reload. User expects to continue with existing branch but starts fresh branch instead.
- Files: `src/backend/services/worktree-lifecycle.service.ts` (lines 49-76)
- Trigger: Call `readResumeModes()` when `.ff-resume-modes.json` contains invalid JSON or unexpected structure
- Workaround: Delete `.ff-resume-modes.json` and restart workspace. Validation falls back to empty object without user feedback.

**Chat WebSocket Connection Leak on Client Exit Without Unregister**
- Symptoms: WebSocket connection remains active consuming memory/CPU after Claude process crashes before cleanup code runs
- Files: `src/backend/services/chat-event-forwarder.service.ts` (lines 500-504), `src/backend/routers/websocket/chat.handler.ts` (lines 240-270)
- Trigger: Claude CLI process killed by OOM or signal before `exit` event handler executes
- Workaround: Monitor WebSocket connection count in production. Manually close connections via admin API if leaked connections accumulate.

**Ratchet State Machine: Missing IDLE Check Before Dispatch**
- Symptoms: Ratchet may dispatch fix session while another fix session is already running, creating duplicate fixes
- Files: `src/backend/services/ratchet.service.ts` (lines 200-250)
- Trigger: Two ratchet checks fire before first fixer session updates `ratchetActiveSessionId` in database
- Workaround: Ratchet service includes concurrency limiting, but race window exists. Monitor PR activity for duplicate fix sessions.

---

## Security Considerations

**GitHub CLI Auth Token Management**
- Risk: `gh auth` stores tokens in `~/.config/gh/hosts.yml`. If process crashes or is killed, tokens remain on disk indefinitely.
- Files: `src/backend/services/github-cli.service.ts` (lines 1-100)
- Current mitigation: Tokens are managed by GitHub CLI, not by application code. User is responsible for token rotation.
- Recommendations: Document token rotation policy. Consider using fine-grained PATs with time limits. Add monitoring for token age/usage in logs.

**Subprocess Command Injection Risk in Shell Execution**
- Risk: If workspace paths or file names are passed to shell commands without proper escaping, attacker-controlled paths could execute arbitrary code
- Files: `src/backend/lib/shell.ts`, `src/backend/claude/process.ts` (lines 134-200)
- Current mitigation: Arguments are passed as array to `spawn()` (not through shell), preventing injection
- Recommendations: Maintain strict use of `spawn()` with array arguments. Add linting rule to prevent shell string concatenation. Add path validation for user-controlled workspace names.

**Database File Permissions on Multi-User Systems**
- Risk: SQLite database file at `~/factory-factory/data.db` has default permissions. On shared systems, other users could read/modify data.
- Files: `src/backend/db.ts` (lines 17-30), `src/backend/lib/env.ts` (database path logic)
- Current mitigation: Default creates directory with mode `0o777`. Application should restrict but doesn't explicitly set permissions.
- Recommendations: After directory creation, explicitly chmod to `0o700` (user-only). Warn in logs if directory is world-readable. Document secure multi-user setup.

**Sensitive Data in Session Logs**
- Risk: Session file logs may contain user-provided prompts, file paths, or tool outputs that include secrets
- Files: `src/backend/services/session-file-logger.service.ts`, `src/backend/services/chat-event-forwarder.service.ts` (lines 107-112)
- Current mitigation: Logs are written to filesystem under workspace directory. No explicit redaction of secrets.
- Recommendations: Implement regex patterns to redact common secret formats (API keys, tokens, passwords). Add configuration for sensitive data redaction. Document log security implications.

---

## Performance Bottlenecks

**GitHub CLI Timeout: All Requests at 30s Default**
- Problem: All gh CLI calls use `GH_TIMEOUT_MS.default` (30s). Complex queries (diff, review details) timeout on large repos.
- Files: `src/backend/services/github-cli.service.ts` (lines 18-25, 200-250)
- Cause: Single-process blocking execution. Timeout of 30s is global for all operations.
- Improvement path: Implement adaptive timeouts based on payload size (diff size = longer timeout). Use streaming for large responses. Cache repeated queries.

**Session Store Hydration: Full History Re-serialization on Every Snapshot**
- Problem: Every state change causes full transcript serialization for snapshot logging. With 1000+ messages, this is expensive.
- Files: `src/backend/services/session-store.service.ts` (lines 86-112, 400-450)
- Cause: No incremental snapshot strategy. All snapshots include full message list.
- Improvement path: Implement delta snapshots that only log changed messages. Add compression for large transcripts. Batch snapshot writes during idle periods.

**Ratchet Service: Linear Workspace Scan on Every Poll**
- Problem: `checkAllWorkspaces()` scans ALL workspaces with PRs every minute, even if most have no state change
- Files: `src/backend/services/ratchet.service.ts` (lines 136-160)
- Cause: No change detection before fetching PR details. Database query includes all workspaces.
- Improvement path: Query only workspaces with recent PR activity. Use ETags from GitHub API for conditional fetches. Increase poll interval or use webhook events instead.

**File Lock Expiration: Linear Scan on Every Operation**
- Problem: `expireLocks()` iterates all locks in store to find expired entries. With thousands of locks, this is O(n).
- Files: `src/backend/services/file-lock.service.ts` (lines 300-330)
- Cause: No index on expiration time. Map iteration happens on every lock operation.
- Improvement path: Use heap-based priority queue for expiration times. Implement background cleanup task instead of per-operation expiration.

---

## Fragile Areas

**Session State Machine: Lifecycle Coordination Between Multiple Services**
- Files: `src/backend/services/session.service.ts`, `src/backend/services/chat-event-forwarder.service.ts`, `src/backend/services/chat-message-handlers.service.ts`, `src/backend/domains/session/session-domain.service.ts`
- Why fragile: Session lifecycle involves at least 4 separate services with interdependencies. Client creation, event setup, message dispatch, and cleanup are spread across files. A missing cleanup step in one service leaks resources.
- Safe modification: Add integration tests that start → send message → stop a session and verify all resources are cleaned up. Create a "session lifecycle checklist" document. Any change to client creation must update cleanup paths.
- Test coverage: Gaps in error path testing. No tests for "client dies during event forwarding" or "cleanup called twice" scenarios.

**Claude Process Monitor: Resource Tracking with Process Signals**
- Files: `src/backend/claude/process.ts`, `src/backend/claude/monitoring.ts`
- Why fragile: Process monitoring relies on signal handling (`SIGTERM`, `SIGKILL`). On Windows or in containerized environments, signals behave differently. Resource tracking may not work as designed.
- Safe modification: Add platform detection tests. Mock process signals in unit tests for all platforms. Verify monitoring works in Docker/container environments before deploying.
- Test coverage: Monitoring tests likely only run on Linux. No Windows-specific testing.

**GitHub CLI Integration: Zod Schema Parsing with Null/Empty String Handling**
- Files: `src/backend/services/github-cli.service.ts` (lines 48-62)
- Why fragile: `reviewDecisionSchema` uses custom preprocessing to convert empty strings to null. If GitHub API response format changes, schema breaks silently. No version detection.
- Safe modification: Add explicit API version detection. Log when empty string preprocessing occurs. Test against historical API responses.
- Test coverage: No tests for API response variations. Schema may drift from actual API behavior.

**Workspace State Machine: Event-Driven State Transitions Without Serialization**
- Files: `src/backend/services/workspace-state-machine.service.ts`
- Why fragile: Multiple services emit state change events. If events fire out of order or duplicate, state becomes inconsistent.
- Safe modification: Implement state transition validation. Add guards that reject invalid state transitions. Log all state changes with before/after snapshots.
- Test coverage: Unit tests cover happy path. No state transition error tests.

---

## Scaling Limits

**SQLite Database: Concurrent Write Contention**
- Current capacity: SQLite handles ~10 concurrent writes with single WAL mode. Better WAL mode improves to ~50 concurrent writers, but still not suitable for high concurrency.
- Limit: At scale (100+ workspaces, 10+ concurrent sessions), database write latency becomes noticeable. Lock timeouts possible.
- Scaling path: Migrate to PostgreSQL or equivalent multi-client database for concurrent write support. Plan for data migration strategy. Consider sharding by project ID.

**Session Store In-Memory Storage: Unbounded Growth**
- Current capacity: All session transcript history stored in memory (`this.stores` map). With 1000 concurrent sessions × 1000 messages each = 1GB+ RAM.
- Limit: Server memory exhaustion at ~500 concurrent sessions with typical message volumes.
- Scaling path: Implement LRU eviction policy for old sessions. Move inactive session state to disk. Add memory usage monitoring and alert thresholds.

**GitHub CLI Command-Line Tool: Sequential Request Bottleneck**
- Current capacity: Each gh CLI invocation spawns a subprocess. With 50+ PR syncs, subprocess spawn overhead becomes significant.
- Limit: PR sync batch can take 30+ seconds to complete for 100 workspaces.
- Scaling path: Implement GitHub API client library instead of CLI wrapping. Batch API requests. Use GraphQL for complex queries to reduce round trips.

**File Lock Service: TTL-Based Cleanup Complexity**
- Current capacity: In-memory storage with no distributed coordination. Works for single process.
- Limit: In cluster setup, each process has its own lock state. Cannot scale beyond single process.
- Scaling path: Move to external lock service (Redis, etcd). Implement distributed lease protocol. Document single-process-only limitation prominently.

---

## Dependencies at Risk

**Claude CLI Binary: External Dependency Not Versioned**
- Risk: Application spawns `claude` command without version check. If CLI behavior changes or is removed, application breaks silently.
- Impact: Breaking changes in Claude CLI mean application must update code + users must upgrade CLI. No fallback or graceful degradation.
- Migration plan: Implement CLI version check on startup. Document required Claude CLI version in README. Add integration tests with specific CLI version. Consider bundling CLI if possible.

**Zod Validation Schemas: Drift From GitHub API Responses**
- Risk: GitHub API changes response format. If schema is not updated, responses silently fail validation and operation fails without clear error.
- Impact: PR syncs fail silently. Users don't know PR data is stale.
- Migration plan: Add GitHub API response validation tests against real API (or snapshot tests). Implement schema versioning. Add monitoring for validation errors.

**p-limit Concurrency Library: Version Pin**
- Risk: If p-limit is upgraded and behavior changes, all concurrency limits throughout codebase may be affected.
- Impact: Potential resource exhaustion if concurrency limits suddenly don't work as expected.
- Migration plan: Pin p-limit version. Add integration tests that verify concurrency limits are respected. Document purpose of each concurrency limit.

---

## Missing Critical Features

**No Structured Logging at Application Level**
- Problem: Logs are created via `createLogger()` but no structured output format. Hard to parse and aggregate in production.
- Blocks: Cannot implement log aggregation, alerting, or analytics. Error tracking requires manual log review.
- Fix approach: Implement structured logging (JSON format) with correlation IDs across requests. Use standard logging library. Add log level configuration.

**No Health Check Endpoint for External Monitoring**
- Problem: Application has internal health checks but no `/health` endpoint for load balancers/orchestrators to monitor.
- Blocks: Cannot implement automated recovery or load balancing based on application health.
- Fix approach: Add `/api/health` endpoint that checks database, file system, and Claude CLI availability. Return structured health status.

**No Rate Limiting on API Endpoints**
- Problem: All tRPC endpoints accept unlimited concurrent requests. No protection against resource exhaustion attacks.
- Blocks: Malicious user can exhaust server resources by sending many concurrent requests.
- Fix approach: Implement per-user rate limiting. Track requests by session/user. Return 429 status when limit exceeded. Configurable limits per endpoint.

**No Request Tracing or Distributed Tracing Support**
- Problem: Cannot trace a request through multiple services. Debugging production issues requires manual log correlation.
- Blocks: Cannot implement service mesh or distributed tracing. Hard to debug performance issues.
- Fix approach: Add request correlation ID to all requests. Pass through service calls. Support OpenTelemetry or similar. Add trace ID to all log entries.

---

## Test Coverage Gaps

**Chat Event Forwarding: Error Recovery Scenarios**
- What's not tested: What happens if WebSocket connection drops mid-event? What if a listener throws an error? What if client.off() fails?
- Files: `src/backend/services/chat-event-forwarder.service.ts`
- Risk: Events are silently dropped if listener crashes. User sees no error.
- Priority: **High** - This is a critical user-facing feature

**Session Lifecycle: Concurrent Start/Stop Scenarios**
- What's not tested: Start session, then immediately start again before first completes. Stop session, then immediately try to send message.
- Files: `src/backend/services/session.service.ts`, `src/backend/services/session.process-manager.ts`
- Risk: Race conditions lead to duplicate processes or orphaned resources.
- Priority: **High** - Session lifecycle is foundational

**Ratchet Service: State Machine Transitions**
- What's not tested: PR state changes rapidly between checks. Ratchet state updated by external entity during check. Fixer session fails while ratchet monitors.
- Files: `src/backend/services/ratchet.service.ts`
- Risk: Ratchet state becomes inconsistent. Fixes don't trigger when needed.
- Priority: **High** - Auto-fix is core feature

**Database Transaction Rollback Scenarios**
- What's not tested: What happens if a Prisma transaction is aborted mid-way? Are all stores consistent?
- Files: `src/backend/resource_accessors/claude-session.accessor.ts`, database-related services
- Risk: Database corruption or silent failures in transactions.
- Priority: **Medium** - Data integrity issue but less likely to trigger

**GitHub API Error Responses**
- What's not tested: GitHub API returns 403 (rate limited), 500 (server error), or 401 (auth failed). Does application handle gracefully?
- Files: `src/backend/services/github-cli.service.ts`
- Risk: Application hangs or returns stale PR data without alerting user.
- Priority: **Medium** - Error path is important but less frequently executed

---

## Architecture Concerns

**Over-Reliance on EventEmitter for Critical Paths**
- Issue: Critical state changes (session start, message dispatch) rely on EventEmitter listeners that are loosely coupled. A missing listener registration is a silent failure.
- Files: `src/backend/services/chat-event-forwarder.service.ts`, `src/backend/domains/session/session-domain.service.ts`
- Impact: State can change without all required listeners being notified, leading to inconsistency
- Fix approach: Implement explicit callback registration with validation. Use interfaces to enforce listener types. Add registry verification at startup.

**Circular Dependencies Between Services**
- Issue: Many services depend on each other (session.service → session-store → session-domain → session.service). Hard to test in isolation.
- Files: `src/backend/services/session.service.ts`, `src/backend/services/session-store.service.ts`, `src/backend/domains/session/session-domain.service.ts`
- Impact: Cannot unit test individual services without mocking entire dependency graph. Changes ripple across services.
- Fix approach: Implement dependency injection explicitly. Create interfaces for each service's public API. Use factories to construct service instances with dependencies.

---

*Concerns audit: 2026-02-09*
