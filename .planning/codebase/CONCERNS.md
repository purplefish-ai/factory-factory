# Codebase Concerns

**Analysis Date:** 2026-02-01

## Tech Debt

**Memory Leaks from Uncleared Intervals and Timeouts:**
- Issue: Multiple services create `setInterval` and `setTimeout` calls without guaranteed cleanup in error scenarios. While most have matching `clearInterval`/`clearTimeout` calls in normal shutdown paths, race conditions during async failures could leave timers running.
- Files:
  - `src/backend/services/file-lock.service.ts` (lines 590, 622)
  - `src/backend/services/terminal.service.ts` (lines 138, 198)
  - `src/backend/services/reconciliation.service.ts` (line 35, 60)
  - `src/backend/services/scheduler.service.ts` (line 37, 64)
  - `src/backend/services/rate-limiter.service.ts` (line 78)
- Impact: Long-running processes may gradually consume more memory. In Electron app (single process lifecycle), uncleared intervals survive until app restart.
- Fix approach: Wrap interval/timeout creation in try-finally blocks or create a CancellationToken pattern. Centralize cleanup in service destruction lifecycle. Test shutdown scenarios.

**In-Memory Lock State Not Cluster-Safe:**
- Issue: `FileLockService` stores locks in-memory with file persistence. Documentation explicitly states single-process limitation. File persistence helps on restart but doesn't provide cross-process synchronization during runtime.
- Files: `src/backend/services/file-lock.service.ts` (lines 12-16)
- Impact: If Factory Factory ever runs in multi-process/cluster mode, concurrent agents in different processes will have conflicting lock views and can corrupt files.
- Fix approach: Add runtime warning or error if deployed in cluster. Consider moving to SQLite-based locking or distributed lock service (Redis-compatible API).

**209 Uses of `any`/`unknown`/`@ts-ignore` Type Violations:**
- Issue: 274 instances of loose typing (`any`, `Record<string, any>`, `unknown` without narrowing, `@ts-ignore`, `@ts-nocheck`) found across codebase. Largest concentrations in WebSocket handlers and chat reducer state management.
- Files:
  - `src/backend/routers/websocket/chat.handler.ts` (multiple JSON.parse with `as ChatMessage` casts)
  - `src/backend/routers/websocket/terminal.handler.ts` (JSON parsing without validation)
  - `src/components/chat/use-chat-state.ts` (chat state updates)
  - `src/backend/services/server-instance.service.ts` (line 11: `let serverInstance: any`)
- Impact: Type safety degradation makes refactoring risky. Potential for runtime errors from malformed WebSocket messages or state mutations.
- Fix approach: Replace `any` with specific types. Add Zod validation for all incoming WebSocket messages. Use discriminated unions for state updates instead of `unknown` payloads.

**Cognitive Complexity Warnings Suppressed:**
- Issue: Multiple `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` directives suppress warnings instead of refactoring.
- Files:
  - `src/backend/routers/websocket/chat.handler.ts` (line 152)
  - `src/backend/routers/websocket/terminal.handler.ts` (lines 76, 152)
  - `src/frontend/components/pr-detail-panel.tsx` (lines 48, 138)
- Impact: Large handler functions are hard to test and debug. WebSocket handlers bundle message dispatch, error handling, session management, and file logging in single function.
- Fix approach: Extract handler logic into separate service methods. Split message types into dedicated handlers (pattern already used in `ChatMessageHandlerService`). Apply same pattern to terminal handler.

## Known Bugs

**Empty Catch Block Missing Error Handling:**
- Issue: Several catch blocks exist but don't log or propagate errors. Example in `src/frontend/components/app-sidebar.tsx` and `src/frontend/components/kanban/kanban-context.tsx` - catch blocks with empty or minimal handling.
- Symptoms: Silent failures in UI state updates. No indication to user if sidebar load fails.
- Files:
  - `src/frontend/components/app-sidebar.tsx`
  - `src/frontend/components/kanban/kanban-context.tsx`
- Workaround: Errors silently fail; UI shows stale state.
- Fix: Log errors, emit user-facing notifications via toast/snackbar.

**Missing Error Toast for Failed File Uploads:**
- Issue: Chat input file upload failure is silently ignored.
- Files: `src/components/chat/chat-input.tsx` (line 258)
- Symptoms: User uploads file, upload fails, no feedback shown. User doesn't know to retry.
- Fix approach: Add error toast notification using existing notification library.

**JSON.parse Without Safe Fallback in Session Reconstruction:**
- Issue: `src/backend/claude/session.ts` (lines 76-89) reads session history files and calls `JSON.parse` on each line with try-catch, but malformed lines are silently skipped. If entire session file is corrupted, no recovery mechanism.
- Symptoms: Session history silently truncates at first malformed line. User loses conversation context.
- Files: `src/backend/claude/session.ts` (lines 72-93)
- Fix approach: Log warnings for skipped lines. Add validation that at least one valid entry exists. Consider backup/rollback mechanism.

## Security Considerations

**innerHTML Assignment in Mermaid Diagram Rendering:**
- Risk: `src/components/ui/markdown.tsx` line 37 uses `ref.current.innerHTML = svg` to render Mermaid output. Although Mermaid library is trusted and error-checked, direct innerHTML assignment could be XSS vector if Mermaid ever has vulnerability.
- Files: `src/components/ui/markdown.tsx` (line 37)
- Current mitigation: Mermaid initialized with `securityLevel: 'strict'`. Try-catch prevents error propagation.
- Recommendations: Use `textContent` + DOM parser instead of innerHTML if possible. Or use React's built-in rendering if Mermaid supports React component export. Monitor Mermaid security advisories.

**dangerouslySetInnerHTML in Chart Component:**
- Risk: `src/components/ui/chart.tsx` uses React's `dangerouslySetInnerHTML` for SVG injection.
- Files: `src/components/ui/chart.tsx`
- Current mitigation: SVG source comes from `recharts` library, validated library, not user input.
- Recommendations: Document why this is necessary. Consider alternative libraries with React component support. Add CSP headers to prevent inline script execution.

**Child Process Spawning Without Input Validation:**
- Risk: Multiple files use `spawn()` and `execFile()` from child_process module without strict argument validation.
- Files:
  - `src/backend/claude/process.ts` (spawns Claude CLI with session ID/working directory)
  - `src/backend/services/github-cli.service.ts` (execFile for git operations)
  - `src/backend/lib/shell.ts` (exec/spawn for shell commands)
  - `src/cli/index.ts` (spawn child processes)
- Current mitigation: Working directories are validated in `validateWorkingDir()` (lines 86-101 of chat.handler.ts). Session IDs come from database.
- Recommendations: Audit all spawn call arguments. Use allowlist for environment variables passed to child processes. Consider sandboxing child processes.

**WebSocket JSON Parsing Without Type Validation:**
- Risk: WebSocket handlers parse incoming JSON without schema validation in some paths.
- Files:
  - `src/backend/routers/websocket/terminal.handler.ts` (line 155 `JSON.parse(data.toString())`)
  - `src/backend/routers/websocket/chat.handler.ts` (line 221 `JSON.parse(data.toString()) as ChatMessage`)
- Current mitigation: Chat handler has `as ChatMessage` cast and error response. Terminal handler has minimal validation.
- Recommendations: Use Zod schemas for all WebSocket message types. Validate before casting. Reject malformed messages with error code.

## Performance Bottlenecks

**Large Component Files with Multiple Concerns:**
- Problem: Several components bundle multiple concerns and exceed 800+ lines.
- Files:
  - `src/components/chat/chat-reducer.ts` (933 lines - state management with 40+ action types)
  - `src/components/chat/use-chat-state.ts` (634 lines - hooks, persistence, WebSocket handling)
  - `src/backend/services/chat-message-handlers.service.ts` (639 lines - message dispatch and all handlers)
  - `src/backend/claude/process.ts` (854 lines - lifecycle, resource monitoring, protocol integration)
- Cause: Monolithic design makes it hard to optimize, test, and debug individual features.
- Improvement path: Split chat reducer by domain (messages, queue, permissions, settings). Extract message handler types into separate files. Use handler registry pattern.

**Resource Monitoring Loop Potential Bottleneck:**
- Problem: `TerminalService.updateAllTerminalResources()` iterates all workspaces/terminals every 1 second and calls `pidusage()` on each PID. With many active terminals, this becomes CPU-intensive.
- Files: `src/backend/services/terminal.service.ts` (lines 158-163, monitoring interval 1000ms)
- Cause: No throttling or sampling. `pidusage()` calls are synchronous in node-pty integration.
- Improvement path: Add sampling (e.g., 10% of terminals per check), or increase interval during low-activity periods. Cache resources for 2-3 seconds between updates.

**File Lock Cleanup Interval Has No Early Exit for Idle Workspaces:**
- Problem: Cleanup runs every 5 minutes regardless of whether workspaces have locks. Iterates all stores synchronously.
- Files: `src/backend/services/file-lock.service.ts` (lines 590-615)
- Cause: No activity tracking or lazy cleanup.
- Improvement path: Track last modification per workspace. Only run cleanup for modified workspaces. Use background garbage collection pattern.

**Chat Reducer State Update Path Lacks Memoization:**
- Problem: `chatReducer` handles 40+ action types with complex state calculations. No memoization on derived state (e.g., queued messages array conversion).
- Files: `src/components/chat/chat-reducer.ts` (entire file)
- Cause: Every reducer call potentially recalculates filtered/mapped state.
- Improvement path: Use `useMemo` for expensive selectors. Consider Immer for immutable updates. Move compute-heavy logic to separate hook.

## Fragile Areas

**Chat Reducer State Machine Complexity:**
- Files: `src/components/chat/chat-reducer.ts`
- Why fragile: 40+ action types, complex state transitions, running/permissions/queue state all interdependent. Edge cases around message queuing during permission requests.
- Safe modification: Document all state transitions in comments. Add exhaustiveness check for action types. Test permission + queue interaction scenarios. Use state machine visualizer (XState) if major changes needed.
- Test coverage: `chat-reducer.test.ts` (1907 lines) has extensive coverage, but edge cases around timing and permission races may not be covered.

**WebSocket Handler Message Dispatch:**
- Files:
  - `src/backend/routers/websocket/chat.handler.ts` (lines 150-260)
  - `src/backend/services/chat-message-handlers.service.ts`
- Why fragile: Direct JSON parsing, no connection state validation, assumes dbSessionId availability, relies on external services (sessionService, messageQueueService). Failed dispatch doesn't close connection.
- Safe modification: Add connection state machine. Validate session exists before processing. Wrap all handlers in try-catch with proper error response. Test with malformed/missing fields in JSON.
- Test coverage: Minimal tests for WebSocket handler. Test timeout scenarios and connection drops during message processing.

**Terminal Resource Monitoring Map Structure:**
- Files: `src/backend/services/terminal.service.ts` (lines 74-84)
- Why fragile: Nested Map structure (workspaceId -> terminalId -> instance). Manual cleanup required. No automatic removal on process exit.
- Safe modification: Add ref-counting for instances. Use WeakMap for automatic GC if feasible. Test terminal exit scenarios to ensure cleanup.
- Test coverage: `terminal.service.test.ts` exists but doesn't extensively test resource cleanup.

**Session Lifecycle with Stop Guard:**
- Files: `src/backend/services/session.service.ts` (lines 24, 42-43, 62-82)
- Why fragile: Global `stoppingInProgress` Set prevents concurrent stops, but if stop promise rejects, session remains in stopping state forever.
- Safe modification: Use timeout on stop operation (currently no timeout). Add reset mechanism on critical errors. Test error scenarios in stop path.
- Test coverage: `session.service` lacks public tests. Logic is tested indirectly through integration tests.

## Scaling Limits

**Single-Process Lock Service Cannot Scale to Multiple Processes:**
- Current capacity: Per-process, in-memory only. Works for single server.
- Limit: Adding multi-process deployment (e.g., load-balanced servers, worker processes) will break.
- Scaling path: Migrate to database-backed locks (SQLite table with expiration) or use distributed lock service (etcd, Redis). Current `FileLockService` has no distributed option.

**Chat Message Queue Unbounded in Memory:**
- Current capacity: `messageQueueService` stores queued messages in memory Map. No size limit checked.
- Limit: Large number of queued messages (e.g., 1000+) could consume significant memory.
- Scaling path: Add max queue size enforcement. Implement message expiration. Consider persistent queue (database) for multi-process scenarios.

**WebSocket Connection Map Linear Lookup:**
- Current capacity: `ChatConnectionService` stores all connections in Map, forwarding to all matching sessions. O(n) lookup and send per message.
- Limit: Thousands of concurrent connections will slow down message forwarding.
- Scaling path: Use connection grouping by session. Add pub/sub pattern (e.g., Redis, EventEmitter with rooms).

**Database Query N+1 Patterns Not Observable:**
- Files: Various resource accessors and routers use Prisma
- Current capacity: No query batching enforced. Each accessor method could trigger multiple queries.
- Limit: Complex UI pages loading many projects/workspaces could trigger dozens of queries.
- Scaling path: Add Dataloader pattern for batch queries. Use Prisma's `include`/`select` optimization guide. Add query logging/analysis.

## Dependencies at Risk

**Security Overrides in pnpm:**
- Risk: `package.json` lines 158-168 have multiple security overrides for dependencies with known vulnerabilities (braces, micromatch, tar, lodash, form-data, tough-cookie).
- Impact: Vulnerabilities patched in newer versions not applied. Could expose to known CVEs.
- Migration plan: Audit each override. Update dependencies to versions where vulnerability is fixed. Remove overrides incrementally. Re-run security scan after each removal.
- Current affected packages:
  - `braces` (3.0.3 override due to ReDoS)
  - `tar` (7.5.0 override)
  - `lodash` (4.17.23 override, very old)

**Mermaid Rendering Library Major Version:**
- Risk: Using `mermaid@11.12.2` which is still active development. Breaking changes possible in minor versions.
- Impact: Diagram rendering could break or introduce new security constraints.
- Migration plan: Pin to exact version in production. Monitor Mermaid releases. Test before updating minor versions.

**Node-pty Native Module Dependency:**
- Risk: `node-pty@1.1.0` requires native module compilation. Breaks in some Node/OS combinations.
- Impact: Installation failures, platform-specific issues (especially Windows/macOS M1).
- Migration plan: Use pre-built binaries (`electron-rebuild` already handles this). Document supported Node versions. Test on target platforms before updating.

## Missing Critical Features

**No Health Check for Backend Subprocess in Electron:**
- Problem: Electron spawns backend as child process. No heartbeat/restart mechanism if backend crashes.
- Blocks: Cannot recover from backend crash without manual app restart.
- Recommended: Add periodic health check (HTTP endpoint). Auto-restart backend if unresponsive. Show UI notification to user.

**No Rate Limiting on WebSocket Message Intake:**
- Problem: WebSocket handlers accept incoming messages without throttling. Malicious or buggy client can flood with messages.
- Blocks: Potential DoS attack vector. No protection against message storms.
- Recommended: Add per-connection rate limit. Use token bucket or sliding window. Disconnect clients exceeding threshold.

**No Request Timeout on Long-Running Operations:**
- Problem: Chat/terminal operations can hang indefinitely. No timeout mechanism on protocol requests.
- Blocks: User cannot cancel stuck operations without killing process.
- Recommended: Add configurable timeout on all async operations. Emit timeout event. Auto-stop session on critical timeouts.

## Test Coverage Gaps

**WebSocket Handler Error Scenarios Untested:**
- What's not tested: Malformed JSON, missing required fields, parsing errors, session-not-found, database errors during message dispatch.
- Files: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/terminal.handler.ts`
- Risk: Error handling code never executed in tests. Could fail at runtime.
- Priority: High - these are critical request paths.

**Chat Reducer Race Condition Scenarios:**
- What's not tested: Rapid permission approvals/denials interleaved with message queuing. State transitions during WebSocket reconnect. Queue overflow scenarios.
- Files: `src/components/chat/chat-reducer.ts` (has extensive tests but edge cases remain)
- Risk: Rare race conditions could cause UI corruption or duplicate messages.
- Priority: High - affects user-visible state.

**File Lock Service Persistence Edge Cases:**
- What's not tested: Disk write failures, corrupted lock file on disk, concurrent file writes from same process, recovery after crash.
- Files: `src/backend/services/file-lock.service.ts`
- Risk: Lock file could become unreadable, preventing new locks. Silent data loss.
- Priority: Medium - would block workspace usage.

**Terminal Resource Monitoring Process Exit:**
- What's not tested: Process exits during resource update, zombie processes not cleaned up, resource monitoring interval cleanup on service shutdown.
- Files: `src/backend/services/terminal.service.ts`
- Risk: Orphaned processes, memory leaks from uncleaned listeners.
- Priority: Medium - impacts long-running stability.

**Session Stop Timeout and Cleanup:**
- What's not tested: Stop operation timeout, stop fails and session left in STOPPING state, cleanup during error paths.
- Files: `src/backend/services/session.service.ts`
- Risk: Session hung in stopping state, cannot be restarted without database intervention.
- Priority: High - blocks user workflow.

---

*Concerns audit: 2026-02-01*
