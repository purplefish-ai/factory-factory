# Codebase Concerns

**Analysis Date:** 2026-02-01

## Tech Debt

**Single-Process File Locking Limitation:**
- Issue: File locking service uses in-memory storage only, not shared across Node.js processes
- Files: `src/backend/services/file-lock.service.ts`
- Impact: Running multiple Factory Factory instances or clustering would cause race conditions on file locks; multi-agent access to the same file in different processes bypasses advisory locks
- Fix approach: Either document single-process requirement clearly in README and enforce via startup check, or implement distributed locking (Redis, etcd) for clustered deployments

**Stale Index Cache in Chat Reducer:**
- Issue: `toolUseIdToIndex` Map caches message array indexes; indexes become invalid if messages are inserted in the middle via `insertMessageByTimestamp()`
- Files: `src/components/chat/chat-reducer.ts` (lines 468-491)
- Impact: Tool input updates may target wrong messages when timestamps cause reordering; cached index is recalculated on mismatch but adds overhead and potential for transient bugs
- Fix approach: Either maintain a secondary index keyed by toolUseId (not position) or remove caching and always scan for tool use messages by ID

**Native Module Rebuild Dependencies:**
- Issue: `better-sqlite3` and `node-pty` require native module compilation; build scripts call `electron-rebuild` with hardcoded module list
- Files: `package.json` (script `rebuild:electron`), `scripts/ensure-native-modules.mjs`
- Impact: Different Node versions or missing build tools cause silent failures; reproducibility issues in CI/CD environments
- Fix approach: Add pre-flight validation to confirm native modules are built correctly; add detailed error messages if modules fail to load

**TypeScript Declaration and Backend Imports:**
- Issue: `src/backend` uses `@prisma-gen/*` aliases that require `@types` generation, but TypeScript configuration for backend is separate
- Files: `tsconfig.backend.json`, `tsconfig.json` (path aliases)
- Impact: Potential for path resolution mismatches during incremental TypeScript builds; `tsc-alias` post-processing adds complexity
- Fix approach: Unify TypeScript configuration or clearly document the build ordering dependencies

## Known Bugs

**Path Traversal Validation Edge Case:**
- Issue: File lock path normalization checks `fullPath.startsWith(worktreePath + path.sep)` but this could be bypassed on case-insensitive filesystems
- Files: `src/backend/services/file-lock.service.ts` (line 323)
- Impact: On macOS (HFS+) or Windows, symlinks or case variations could potentially access files outside workspace
- Workaround: Use `path.relative()` and reject if result starts with `..`
- Fix approach: Refactor path validation to use `path.relative()` and verify it doesn't contain `..`

**Git Fetch Failure Fallback Not Tested:**
- Issue: Git client falls back to local/stale origin branches if fetch fails, but doesn't distinguish between "offline" vs "branch doesn't exist" failures
- Files: `src/backend/clients/git.client.ts` (lines 72-80)
- Impact: Silent creation of worktrees from stale branch refs if network is intermittent; user gets wrong branch without clear error message
- Workaround: Check git status after worktree creation
- Fix approach: Add explicit error classification for fetch failures; log which branch ref was used as fallback

**Shell Argument Escaping for MacOS Notifications:**
- Issue: `escapeForOsascript()` truncates to 200 characters but doesn't handle all edge cases in AppleScript double-quote escaping
- Files: `src/backend/lib/shell.ts` (lines 60-67)
- Impact: Very long notification titles/messages are silently truncated; some special characters in notifications might break the AppleScript
- Fix approach: Add validation before truncation to warn if notification will be cut; test with Unicode and special characters

## Security Considerations

**WebSocket Session Validation:**
- Risk: Chat WebSocket handler validates `workingDir` via `resolve()` and existence check, but doesn't validate that it belongs to the workspace
- Files: `src/backend/routers/websocket/chat.handler.ts` (lines 89-108)
- Current mitigation: Path traversal protection via startsWith check after resolve
- Recommendations: Add explicit workspace ownership verification; log all working directory changes

**CLI Process Stdio Buffer Handling:**
- Risk: Claude process stderr buffer collects all output without size limits in early phases
- Files: `src/backend/claude/process.ts` (line 149: `private stderrBuffer: string[] = []`)
- Current mitigation: Buffer is only used during initialization, not entire process lifetime
- Recommendations: Set maximum buffer size; add metrics for buffer usage; consider streaming to file for large outputs

**Git Command Argument Validation:**
- Risk: Most git commands use safe `spawn()` with array args, but branch names should be validated before use
- Files: `src/backend/clients/git.client.ts`, `src/backend/lib/git-helpers.ts`
- Current mitigation: `isAutoGeneratedBranchName()` validates auto-generated names; user-provided branch names passed through
- Recommendations: Validate all user-provided branch/ref names against git refname rules; add deny-list for dangerous refs

**Rate Limiter Queue DoS:**
- Risk: Rate limiter has `maxQueueSize` limit but queue is per-instance; rapid request submission could queue many long-running timeouts
- Files: `src/backend/services/rate-limiter.service.ts` (lines 151-152, 196-204)
- Current mitigation: Fixed max queue size prevents unbounded growth; timeouts are tracked and cleared on rejection
- Recommendations: Add metrics for queue rejection rate; implement adaptive backpressure; document queue timeout value (currently 10s from config)

## Performance Bottlenecks

**Chat Reducer Message Scan for Tool Use:**
- Problem: TOOL_INPUT_UPDATE falls back to linear O(n) scan through messages if cached index is stale
- Files: `src/components/chat/chat-reducer.ts` (lines 485-486)
- Cause: O(1) map cache becomes invalid when messages are reordered by timestamp
- Improvement path: Separate tool use messages into a dedicated indexed structure, or use a pointer-stable ID -> Message mapping instead of array index

**Git Worktree Listing Performance:**
- Problem: `listWorktrees()` spawns a git command for every check, no caching
- Files: `src/backend/clients/git.client.ts`
- Cause: Each lookup spawns a new process
- Improvement path: Cache worktree listing with 5-10 second TTL; invalidate cache on create/delete operations

**Database Query Without Indexes:**
- Problem: Several workspace queries filter on `status` and `cachedKanbanColumn` but don't use composite indexes efficiently
- Files: `prisma/schema.prisma` (schema has indexes but queries may bypass them)
- Cause: ORM query planning depends on database statistics; large tables could fall back to full scans
- Improvement path: Add `ANALYZE` to migration scripts; monitor slow query logs in production

**WebSocket Message Compression Overhead:**
- Problem: Event compression service applies delta compression to every message, even small ones
- Files: `src/backend/services/event-compression.service.ts`
- Cause: Compression overhead for small messages can exceed savings
- Improvement path: Skip compression for messages under 500 bytes; only compress high-frequency event types

## Fragile Areas

**Message State Machine State Transitions:**
- Files: `src/backend/services/message-state.service.ts`, `src/components/chat/chat-reducer.ts`
- Why fragile: Multiple state machines (backend MessageState + frontend SessionStatus + UI queuedMessages) must stay in sync; dispatching wrong message type to wrong state causes silent ignores
- Safe modification: Add comprehensive state transition logging; use discriminated unions for all state types (already done for SessionStatus but not MessageState)
- Test coverage: Test all state transition edges, not just happy path; test reconnect scenarios where states diverge

**Claude CLI Process Lifecycle Management:**
- Files: `src/backend/claude/process.ts`, `src/backend/claude/session.ts`
- Why fragile: Process spawning, resource monitoring, hung process detection, and graceful shutdown are intertwined; hung process timeout can kill process during critical operations
- Safe modification: Separate concerns into distinct state machines; add operation guards (e.g., "don't kill process during permission request")
- Test coverage: Test hung process detection with controlled delays; test shutdown while messages are in flight

**Workspace State Machine Initialization:**
- Files: `src/backend/services/workspace-state-machine.service.ts`
- Why fragile: Workspace transitions from NEW → PROVISIONING → READY; git worktree creation and startup script execution must both succeed; no rollback if startup script fails
- Safe modification: Add explicit cleanup state; document what state means for each `WorkspaceStatus` value
- Test coverage: Test startup script failures; test partial creation (worktree exists but script failed); test recovery from FAILED state

**Event Forwarder Setup Idempotency:**
- Files: `src/backend/services/chat-event-forwarder.service.ts` (lines 88-100)
- Why fragile: `setupClientEvents()` is idempotent and skips if already called, but there's no way to update event handlers if client config changes (e.g., switching models)
- Safe modification: Add explicit "refresh" method that updates handlers even if already set up; or remove idempotency guard and rely on event listener de-duplication
- Test coverage: Test reconnect with changed settings; verify only one listener per event type

## Scaling Limits

**In-Memory Client Cache:**
- Current capacity: One active `ClaudeClient` per workspace in memory
- Limit: With 1000+ workspaces, memory usage grows unbounded; stale clients not garbage collected if workspace is deleted
- Scaling path: Implement LRU cache with eviction; add workspace cleanup that unregisters clients; monitor memory usage per client

**SQLite Database Concurrency:**
- Current capacity: Better-sqlite3 allows concurrent reads, but writes are serialized with a single connection
- Limit: High-frequency writes (message state changes, kanban updates) will bottleneck under load
- Scaling path: Add read replicas (SQLite can't do this), migrate to PostgreSQL for multi-connection support, or implement write queue with batching

**File Lock Storage:**
- Current capacity: All locks stored in memory for all workspaces
- Limit: With 10,000+ files locked across many workspaces, Map iteration becomes slow; no persistence across restarts loses all locks
- Scaling path: Move to proper distributed locking service (Redis); implement lock persistence to database instead of JSON files

**Terminal Session PTY Pool:**
- Current capacity: One PTY spawned per TerminalSession, no pooling or reuse
- Limit: OS limits on open PTYs; resource leaks if terminals aren't properly cleaned up
- Scaling path: Add resource cleanup on session deletion; monitor open file descriptor count; implement terminal session recycling

## Dependencies at Risk

**Node-PTY (Breaking Changes Risk):**
- Risk: Node-PTY relies on native bindings; updates may require recompiling; v1.1.0 is relatively old
- Impact: New Node.js versions might not have pre-built binaries; CI/CD breaks if build tools aren't available
- Migration plan: Monitor releases for security updates; add fallback to simpler terminal approach (exec instead of PTY) for critical paths

**Better-SQLite3 (Licensing/Performance):**
- Risk: Tight coupling to SQLite; v12.6.2 brings performance improvements but also API changes
- Impact: Migration to PostgreSQL would require schema and query changes; tight SQLite-specific optimizations would need rewriting
- Migration plan: Add abstraction layer over database queries (already using Prisma); keep data model database-agnostic; document migration cost estimate (2-3 weeks)

**Electron (Desktop Distribution):**
- Risk: Electron package is large (~200MB); security updates are frequent
- Impact: Slow distribution; must rebuild when Electron updates; distributing pre-built binaries is complex
- Migration plan: Consider web-only distribution; Electron is optional, not core

**Claude SDK Version Pinning:**
- Risk: Claude CLI is external dependency with no version pinning; updates could break API
- Impact: Unexpected failures if Claude SDK introduces breaking changes
- Migration plan: Add wrapper layer around Claude invocation; document expected SDK version; add health checks at startup

## Missing Critical Features

**Graceful Shutdown on Signal:**
- Problem: SIGTERM handling not implemented; running workspaces/processes not cleaned up on server shutdown
- Blocks: Cannot safely restart server without orphaning Claude processes; resource leaks accumulate

**Workspace Recovery/Rollback:**
- Problem: If workspace initialization fails halfway through, no way to clean up partial state
- Blocks: Users can't recover from failed workspace creation; must manually clean up git worktrees

**Cross-Session Message Synchronization:**
- Problem: Message state is only synced on WebSocket reconnect; if user opens multiple browser tabs, they see different message histories
- Blocks: Multi-tab browsing is confusing; losing tab loses session context

## Test Coverage Gaps

**File Lock Service Cross-Process Concurrency:**
- What's not tested: Two separate Node.js processes acquiring/releasing the same file lock
- Files: `src/backend/services/file-lock.service.test.ts`
- Risk: In-memory lock state doesn't synchronize across processes; persistent file reads might be stale if another process writes after lock acquired
- Priority: HIGH (blocking multi-process deployments)

**Git Worktree Cleanup on Error:**
- What's not tested: If git worktree creation succeeds but startup script fails, is worktree deleted?
- Files: `src/backend/trpc/workspace/init.trpc.ts`, git client tests
- Risk: Stale worktrees accumulate; disk space leaks
- Priority: HIGH

**Claude Process Hung Detection:**
- What's not tested: Process activity timeout behavior; does `activityTimeoutMs` correctly kill hung processes?
- Files: `src/backend/claude/process.ts`
- Risk: Hung processes consume resources indefinitely; users don't know session is stuck
- Priority: HIGH

**WebSocket Reconnect Message Deduplication:**
- What's not tested: Reconnecting while message is in-flight; is duplicate message correctly rejected?
- Files: `src/components/chat/chat-reducer.ts` (lines 661-668), message state service
- Risk: Duplicate messages appear in history on reconnect with multi-tab scenario
- Priority: MEDIUM

**Rate Limiter Queue Timeout Cleanup:**
- What's not tested: Request timeout during shutdown; are all pending timeouts cleared?
- Files: `src/backend/services/rate-limiter.service.ts` (lines 322-332)
- Risk: Timeouts might not be cleared if shutdown is forced; could cause process hang
- Priority: MEDIUM

**Terminal Session PTY Signal Handling:**
- What's not tested: Killing terminal session while subprocess is running; does PTY properly handle SIGHUP?
- Files: `src/backend/routers/websocket/terminal.handler.ts`
- Risk: Orphaned processes; terminal cleanup not working as expected
- Priority: MEDIUM

**Concurrent Message Dispatch:**
- What's not tested: Two concurrent `tryDispatchNextMessage()` calls for same session; does guard work correctly?
- Files: `src/backend/services/chat-message-handlers.service.ts` (lines 88-97)
- Risk: Messages might be dispatched multiple times or skipped if concurrency guard has race condition
- Priority: MEDIUM

---

*Concerns audit: 2026-02-01*
