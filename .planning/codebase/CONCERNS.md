# Codebase Concerns

**Analysis Date:** 2026-01-29

## Tech Debt

**Large monolithic backend file:**
- Issue: `src/backend/index.ts` is 1980 lines - contains server initialization, WebSocket handlers, chat client management, terminal lifecycle, and message routing all in one file.
- Files: `src/backend/index.ts`
- Impact: Difficult to navigate, test, and maintain. Changes to WebSocket logic require touching server setup. Hard to reason about state management across concerns.
- Fix approach: Extract WebSocket handlers into dedicated modules (`chat-websocket.ts`, `terminal-websocket.ts`), move client/session management to separate services. Reduce file to ~500 lines of pure server setup.

**Large hook file with tight coupling:**
- Issue: `src/components/chat/use-chat-websocket.ts` is 1057 lines with complex state management, message queuing, reconnection logic, settings persistence, and WebSocket lifecycle all mixed together.
- Files: `src/components/chat/use-chat-websocket.ts`
- Impact: Difficult to test individual concerns, high risk of regressions when modifying reconnection or message handling logic.
- Fix approach: Extract reconnection logic to `use-websocket-reconnect.ts`, message queue handling to `use-message-queue.ts`, settings persistence to `use-chat-settings.ts`. Current file should be 300-400 lines.

**Complex component with embedded state:**
- Issue: `src/client/routes/projects/workspaces/detail.tsx` is 1055 lines mixing layout rendering, chat integration, workspace panel management, git operations, and session switching.
- Files: `src/client/routes/projects/workspaces/detail.tsx`
- Impact: Hard to modify chat layout, panel behavior, or session management independently. Single responsibility violated.
- Fix approach: Extract `ChatSection`, `WorkspacePanelWrapper`, `SessionManager` components. Main component becomes 300 lines orchestrating these pieces.

**Test-related large fixture file:**
- Issue: `src/lib/claude-fixtures.ts` is 1111 lines and `src/lib/claude-types.ts` is 1052 lines - both contain type definitions, test fixtures, and utilities mixed together.
- Files: `src/lib/claude-fixtures.ts`, `src/lib/claude-types.ts`
- Impact: Difficult to find what you need; importing from these files pulls in many unrelated dependencies and types.
- Fix approach: Separate types from fixtures. Create `src/lib/claude-types-core.ts` with just type definitions, `src/backend/testing/fixtures.ts` for backend test fixtures.

## Known Bugs

**WebSocket reconnection may lose pending messages:**
- Symptoms: Messages queued while Claude CLI is starting can be lost if the WebSocket disconnects and reconnects while messages are in `pendingMessages` Map.
- Files: `src/backend/index.ts` (lines 1028-1061), `src/components/chat/use-chat-websocket.ts` (pending message handling)
- Trigger: User sends message while session is starting, then network disconnects before session fully initializes. Reconnect loads session state but queue was in-memory only.
- Workaround: Messages are persisted to localStorage on frontend, but backend has no durability guarantee. Manual reload required if queue is lost.

**Race condition in client creation during concurrent starts:**
- Symptoms: Multiple `getOrCreateChatClient` calls in rapid succession may create duplicate ClaudeClient instances before `pendingClientCreation` promise settles.
- Files: `src/backend/index.ts` (lines 870-960)
- Trigger: Frontend sends multiple `start` messages before first session is ready, or React renders component twice in StrictMode.
- Current mitigation: `pendingClientCreation` Map prevents most cases, but early race window exists between client creation and map insertion.
- Safe fix: Move `pendingClientCreation.set()` to happen BEFORE the async function starts executing.

**Terminal resource monitoring never auto-kills (intentional design):**
- Symptoms: Long-running terminals with memory leaks will consume unbounded memory but won't be killed.
- Files: `src/backend/services/terminal.service.ts` (lines 1-12 explicitly state this is intentional)
- Impact: One runaway terminal can eventually cause server OOM.
- Fix approach: Document clearly in admin dashboard. Add optional TTL configuration per terminal. Emit warnings when resource usage exceeds thresholds.

## Security Considerations

**File path traversal protection has gaps:**
- Risk: `validateWorkingDir()` checks for `..` and resolves symlinks, but path validation happens per-message. Symlink changes between validation and use could be exploited.
- Files: `src/backend/index.ts` (lines 1221-1263)
- Current mitigation: `realpathSync()` resolves symlinks, prevents escaping via symlinks created after initial check.
- Recommendations: Add whitelist of allowed directories in config. Store validated paths in session context to avoid re-validating each message. Consider read-only file access for file operations.

**WebSocket authentication is implicit (trusts frontend):**
- Risk: `dbSessionId` parameter in WebSocket URL comes from frontend without explicit authentication. Any client knowing session ID can hijack the chat session.
- Files: `src/backend/index.ts` (lines 1274-1284)
- Current mitigation: Session ID is a UUID, hard to guess. Frontend loads sessions from database.
- Recommendations: Add HMAC signature of sessionId + timestamp. Require authentication token in WebSocket header. Validate that connecting user owns the workspace.

**CLI process spawning inherits parent environment:**
- Risk: Sensitive environment variables (API keys, tokens) from parent process are inherited by spawned Claude CLI processes.
- Files: `src/backend/claude/process.ts` (spawn inherits process.env by default)
- Current mitigation: No explicit mitigation found.
- Recommendations: Explicitly whitelist safe env vars to pass to child process. Create clean env object with only required vars (NODE_ENV, PATH, HOME, etc.). Clear sensitive vars before spawn.

**MCP tool execution lacks input validation:**
- Risk: Tool inputs from Claude are not validated before execution, relying on tool handlers to validate safely.
- Files: `src/backend/routers/mcp/server.ts`
- Current mitigation: Individual tools (terminal, system) have some validation, but no centralized input sanitization.
- Recommendations: Implement schema validation for all MCP tools. Use Zod/TypeBox for input validation before passing to handlers.

## Performance Bottlenecks

**Chat message broadcasting iterates entire connection map:**
- Problem: `forwardToConnections()` loops through all chat connections every time Claude sends a message, even if only one client is viewing the session.
- Files: `src/backend/index.ts` (lines 601-639)
- Cause: Linear scan of `chatConnections` Map to find matching `dbSessionId`. With many concurrent sessions, this becomes O(n).
- Improvement path: Index `chatConnections` by dbSessionId: `Map<dbSessionId, Set<connectionId>>`. Reduces lookup from O(n) to O(1).

**Terminal output buffer unbounded:**
- Problem: `outputBuffer` in `TerminalInstance` accumulates all terminal output, no limit on size.
- Files: `src/backend/services/terminal.service.ts` (line 48)
- Cause: Buffer is meant for reconnection restoration but grows indefinitely with long-running terminals.
- Improvement path: Implement circular buffer with max size (e.g., 100KB). Store older output in rotating file. Reduce memory footprint for long sessions.

**Pending messages queue enforced globally, not per-session:**
- Problem: `MAX_PENDING_MESSAGES` constant (grep shows no definition - needs checking) limits total queue size, but all sessions share same limit.
- Files: `src/backend/index.ts` (lines 1035-1048)
- Cause: If one slow session starts, others can't queue messages.
- Improvement path: Make limit per-session or per-dbSessionId, not global. Allow configurable queue size.

**File lock persistence reads/writes entire lock store each operation:**
- Problem: Every lock acquire/release reads entire `advisory-locks.json`, modifies one lock, writes entire file back.
- Files: `src/backend/services/file-lock.service.ts` (lines 1-30 document this)
- Cause: In-memory Map for speed, but file I/O not optimized.
- Improvement path: Implement journaling or delta persistence. Only write changed locks to file. Batch writes for multiple operations.

## Fragile Areas

**Claude process lifecycle with orphan cleanup:**
- Files: `src/backend/claude/process.ts`, `src/backend/services/reconciliation.service.ts`
- Why fragile: Process can crash, be killed externally, or hang. Reconciliation cleanup runs periodically (not on-demand). If reconciliation fails, orphan processes accumulate.
- Safe modification: Add explicit process state validation before every operation. Don't assume process is alive. All process operations should check `this.process?.pid` exists.
- Test coverage: Missing tests for hung process detection, cleanup of killed processes, orphan recovery after reconciliation failure.

**WebSocket message ordering with concurrent operations:**
- Files: `src/backend/index.ts` (message handling in handleChatMessage)
- Why fragile: Messages arriving out of order (network reordering) can cause state inconsistency. Example: `stop` arrives before `user_input` completes, or settings change mid-execution.
- Safe modification: Implement message sequence numbers. Reject out-of-order messages or buffer them. Add request/response correlation IDs.
- Test coverage: No tests for concurrent message handling, message reordering, or race conditions between start/stop/input.

**Terminal session state with network flakiness:**
- Files: `src/backend/index.ts` (terminal WebSocket handlers, lines 1530-1680)
- Why fragile: Terminal state in server doesn't sync with frontend UI if network hiccups. Terminal can die but frontend still thinks it's alive.
- Safe modification: Implement heartbeat on terminal connection. Send periodic `alive` messages. Frontend should detect stale terminal and prompt user.
- Test coverage: Missing tests for terminal death detection, reconnection recovery, state sync on reconnect.

## Scaling Limits

**In-memory session tracking for distributed deployments:**
- Current capacity: Single process only. Can't scale horizontally.
- Limit: Where it breaks: Adding second Node.js instance - each has own `chatClients`, `chatConnections`, `pendingMessages` Maps. Messages sent to wrong server, sessions can't migrate.
- Scaling path: Move session state to Redis. Use Redis Pub/Sub for message broadcasting across servers. Implement server-to-server routing by workspaceId.

**Database is SQLite, single-file for all users:**
- Current capacity: Good for <10 concurrent projects. SQLite has table-level locking.
- Limit: Multiple Claude processes writing to DB simultaneously will hit locks. PR sync scheduler competes with user queries.
- Scaling path: Migrate to PostgreSQL for concurrent writes. Add connection pooling with PgBouncer. Implement optimistic concurrency with version fields.

**Process registry uses in-memory Map:**
- Current capacity: Can track ~100 processes per server.
- Limit: Long-running servers accumulate dead processes if cleanup fails. Memory doesn't get reclaimed.
- Scaling path: Implement periodic process cleanup by PID validation. Use WeakMap where feasible. Add persistent process registry to database.

## Dependencies at Risk

**node-pty dependency (terminal emulation):**
- Risk: Node-pty is a native module with binary components. Breaking changes between Node.js versions common. Limited maintainers.
- Impact: Terminal feature breaks on Node.js upgrades until node-pty updates.
- Migration plan: Monitor node-pty releases. Document required Node.js version in README. Consider fallback to simpler subprocess spawning if node-pty unavailable.

**@prisma/adapter-better-sqlite3 (database):**
- Risk: Better-sqlite3 is a native SQLite binding. If it becomes incompatible with latest Node.js, app can't start.
- Impact: Database queries fail, entire backend crashes.
- Migration plan: Review better-sqlite3 releases monthly. Have migration path to PostgreSQL adapter ready. Test with new Node.js versions in CI before release.

**pidusage (process monitoring):**
- Risk: pidusage is a native module for reading process stats. Not heavily maintained.
- Impact: Resource monitoring in admin dashboard fails, process killing based on resource limits doesn't work.
- Migration plan: Consider reading /proc directly on Linux. Use built-in process.memoryUsage() for initial implementation.

## Missing Critical Features

**No audit trail for Claude tool execution:**
- Problem: No way to know which tools were executed, when, and with what inputs (except session file logs). Can't trace security issues.
- Blocks: Compliance audits, debugging production issues, rollback decisions.

**No rate limiting on Claude message sends:**
- Problem: User can spam messages and Claude will process all of them, causing high resource usage.
- Blocks: Protecting server from user abuse, fair resource allocation.

**No session persistence/recovery mechanism:**
- Problem: If server crashes, all in-flight Claude sessions are lost. No way to recover state.
- Blocks: Long-running sessions, production deployments, enterprise features.

**No multi-workspace session management:**
- Problem: Each session is tied to one workspace. Can't switch contexts quickly.
- Blocks: Users managing multiple parallel tasks.

## Test Coverage Gaps

**WebSocket connection lifecycle untested:**
- What's not tested: Connection establishment, disconnection, reconnection, message buffering during downtime, heartbeat detection of dead connections.
- Files: `src/backend/index.ts` (WebSocket handlers), `src/components/chat/use-chat-websocket.ts`
- Risk: Core communication channel has no automated tests. Regressions in reconnection could break app.
- Priority: High - this is critical path.

**Claude CLI process spawning and cleanup:**
- What's not tested: Process spawn failure, graceful shutdown, hung process detection, resource limit enforcement.
- Files: `src/backend/claude/process.ts`
- Risk: Process lifecycle bugs could accumulate orphan processes, leak resources.
- Priority: High - resource management is critical.

**Chat message ordering and concurrency:**
- What's not tested: Messages arriving out of order, concurrent start/stop, message sending while session starting, queue overflow.
- Files: `src/backend/index.ts` (lines 962-1100)
- Risk: Race conditions in message handling could lose messages or cause state inconsistency.
- Priority: High - affects core chat flow.

**Terminal session with network flakiness:**
- What's not tested: Terminal death detection, reconnection with missed output, output buffer restoration.
- Files: `src/backend/index.ts` (terminal handlers), `src/backend/services/terminal.service.ts`
- Risk: Terminal sessions fail silently, user doesn't know terminal is dead.
- Priority: Medium - impacts terminal experience but not critical path.

**File lock service under concurrent access:**
- What's not tested: Concurrent lock acquisition on same file, lock expiration race, TTL cleanup.
- Files: `src/backend/services/file-lock.service.ts`
- Risk: File locks could deadlock or not be released, blocking workspace operations.
- Priority: Medium - only used during concurrent Claude sessions.

**Git operations in workspace module:**
- What's not tested: Branch creation during concurrent changes, PR detection race conditions, git command failures.
- Files: `src/backend/clients/git.client.ts` (tested), but interceptors untested.
- Risk: Branch/PR operations could fail silently or create inconsistent state.
- Priority: Medium - affects workflow but not core chat.

---

*Concerns audit: 2026-01-29*
