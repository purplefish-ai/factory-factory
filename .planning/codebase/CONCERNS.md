# Codebase Concerns

**Analysis Date:** 2026-01-31

## Tech Debt

**Deprecated API Fields (claude-types.ts):**
- Issue: ToolSequence has deprecated fields `messages`, `toolNames`, `statuses` alongside new `pairedCalls`
- Files: `src/lib/claude-types.ts:971-976`
- Impact: Increases bundle size, confusing API surface, maintenance burden
- Fix approach: Remove deprecated fields after confirming no consumers, update any code using old fields

**Deprecated Methods (git.client.ts):**
- Issue: `getBranchName()` marked deprecated but still present
- Files: `src/backend/clients/git.client.ts:152-156`
- Impact: Confusing API, potential for incorrect usage
- Fix approach: Complete migration to `generateBranchName()`, remove deprecated method

**Deprecated WebSocket Config:**
- Issue: `RECONNECT_DELAY` constant deprecated in favor of `getReconnectDelay()`
- Files: `src/lib/websocket-config.ts:30`
- Impact: Confusion for developers on which to use
- Fix approach: Remove deprecated constant after verifying no usage

**Biome Lint Suppressions:**
- Issue: 40+ `biome-ignore` comments scattered throughout codebase, many for cognitive complexity
- Files: Multiple files including `src/backend/routers/websocket/chat.handler.ts:1134`, `src/backend/routers/websocket/terminal.handler.ts:76,152`, `src/frontend/components/pr-detail-panel.tsx:48,111,138`
- Impact: These mark areas needing refactoring that were deferred
- Fix approach: Extract complex handlers into smaller functions, simplify conditional logic

**Single-Process File Lock Limitation:**
- Issue: Advisory file locks are in-memory only, not shared across Node.js processes
- Files: `src/backend/services/file-lock.service.ts:13-16`
- Impact: Locks don't work in clustered deployments, only on restart via file persistence
- Fix approach: Consider Redis-based locking for multi-process support if clustering is needed

## Known Issues

**Silent Upload Failures:**
- Issue: File upload errors are silently ignored with a TODO comment
- Files: `src/components/chat/chat-input.tsx:256-258`
- Impact: Users don't know when file uploads fail
- Fix approach: Add toast notification system for upload errors

## Security Considerations

**Shell Command Execution:**
- Risk: Multiple spawn/exec calls throughout codebase for shell operations
- Files: `src/backend/claude/process.ts:216`, `src/backend/services/terminal.service.ts:242`, `src/backend/services/startup-script.service.ts:181`, `src/backend/services/run-script.service.ts:96,237`, `src/backend/lib/shell.ts:131`
- Current mitigation: `src/backend/lib/shell.ts` provides centralized safe shell execution with input validation and escaping
- Recommendations: Ensure all shell execution goes through the centralized shell library; audit any direct spawn calls

**Environment Variable Exposure:**
- Risk: Many process.env accesses throughout codebase without centralized validation
- Files: 40+ files access `process.env` directly
- Current mitigation: `src/backend/services/config.service.ts` provides centralized config, `src/backend/lib/env.ts` for path expansion
- Recommendations: Migrate all env var access to go through config service

**Security Headers (Basic):**
- Risk: Security middleware only sets basic headers
- Files: `src/backend/middleware/security.middleware.ts`
- Current mitigation: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy headers set
- Recommendations: Add Content-Security-Policy header, consider HSTS for production

**User Settings Command Validation:**
- Risk: Custom IDE command allows arbitrary shell execution
- Files: `src/backend/trpc/user-settings.trpc.ts:45-87`
- Current mitigation: Validates presence of `{workspace}` placeholder, blocks shell metacharacters
- Recommendations: Consider allowlist approach for IDE commands rather than blocklist

## Performance Concerns

**Large Files - Potential Complexity Hotspots:**
- Problem: Several files exceed 600+ lines indicating potential refactoring needs
- Files:
  - `src/components/chat/chat-reducer.test.ts` (1907 lines)
  - `src/backend/routers/websocket/chat.handler.ts` (1238 lines)
  - `src/lib/claude-types.ts` (1125 lines)
  - `src/backend/claude/process.ts` (861 lines)
  - `src/components/agent-activity/tool-renderers.tsx` (796 lines)
  - `src/components/ui/sidebar.tsx` (745 lines)
- Cause: Feature accumulation over time, complex state management
- Improvement path: Split into smaller modules, extract shared utilities

**Message List Performance:**
- Problem: Virtualized message list has performance considerations during streaming
- Files: `src/components/chat/virtualized-message-list.tsx:86-91`
- Cause: Reduces overscan during active running for better performance
- Improvement path: Already optimized with conditional overscan; monitor for further issues

**Concurrent Operation Limits:**
- Problem: Rate limiting for PR syncs and git operations
- Files: `src/backend/services/scheduler.service.ts:18,24`, `src/backend/trpc/workspace.trpc.ts:27`
- Cause: Prevents resource exhaustion on simultaneous operations
- Improvement path: Monitor limits, adjust MAX_CONCURRENT_PR_SYNCS (5) if needed

## Fragile Areas

**Chat WebSocket Handler:**
- Files: `src/backend/routers/websocket/chat.handler.ts`
- Why fragile: 1238 lines handling session lifecycle, message forwarding, tool interception, pending requests
- Safe modification: Understand the full session state machine, test with multiple concurrent sessions
- Test coverage: No dedicated test file exists for this handler

**Workspace State Machine:**
- Files: `src/backend/services/workspace-state-machine.service.ts`
- Why fragile: Controls critical workspace provisioning transitions with atomic updates
- Safe modification: All changes must go through state machine methods, never direct DB updates
- Test coverage: Good coverage at `src/backend/services/workspace-state-machine.service.test.ts` (518 lines)

**Claude Process Management:**
- Files: `src/backend/claude/process.ts`, `src/backend/claude/index.ts`
- Why fragile: Complex IPC with Claude CLI, hung process detection, graceful shutdown logic
- Safe modification: Test with actual Claude CLI, watch for timing issues
- Test coverage: Protocol tested at `src/backend/claude/protocol.test.ts`

**Pending Interactive Requests:**
- Files: `src/backend/routers/websocket/chat.handler.ts:42-44`
- Why fragile: Session state for pending permission/question requests must survive reconnections
- Safe modification: Ensure pendingInteractiveRequests Map stays in sync with session state
- Test coverage: Limited direct testing of reconnection scenarios

## Scaling Limits

**SQLite Database:**
- Current capacity: Single-file SQLite database
- Limit: Concurrent write contention, single-node only
- Scaling path: Database path configurable; migrate to PostgreSQL if multi-node needed

**In-Memory State:**
- Current capacity: `chatConnections`, `pendingInteractiveRequests`, terminal instances all in-memory
- Limit: Memory grows with active sessions, lost on restart
- Scaling path: Consider Redis for session state if horizontal scaling needed

**File Lock Service:**
- Current capacity: In-memory per-process locks with file persistence
- Limit: Not shared across processes in cluster mode
- Scaling path: Redis-based distributed locking

## Dependencies at Risk

**node-pty:**
- Risk: Native module requiring compilation, can break on Node.js version upgrades
- Files: `src/backend/services/terminal.service.ts:14,242`
- Impact: Terminal functionality depends on this
- Migration plan: Keep Node.js version stable, test terminal on upgrades

**EventEmitter Type Safety:**
- Risk: Multiple biome-ignore comments for `noExplicitAny` on EventEmitter handlers
- Files: `src/backend/claude/process.ts:513,534`, `src/backend/claude/permissions.ts:559,576,578`, `src/backend/claude/protocol.ts:497,509`, `src/backend/claude/index.ts:423,438`
- Impact: Type safety reduced for event handling
- Migration plan: Consider typed-emitter library or custom typed event system

## Missing Critical Features

**Error Notification System:**
- Problem: TODO to show error toast for failed uploads
- Files: `src/components/chat/chat-input.tsx:258`
- Blocks: Users don't get feedback on upload failures

**Test Coverage for WebSocket Handlers:**
- Problem: Chat and terminal WebSocket handlers lack dedicated test files
- Files: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/terminal.handler.ts`
- Blocks: Refactoring is risky without tests

## Test Coverage Gaps

**WebSocket Handlers Untested:**
- What's not tested: Chat handler message routing, terminal handler attach/detach
- Files: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/terminal.handler.ts`
- Risk: Regressions in core real-time functionality
- Priority: High

**Frontend Components with Stories but No Tests:**
- What's not tested: 25 Storybook story files for visual testing but limited unit test coverage
- Files: Various `.stories.tsx` files in `src/components/` and `src/frontend/components/`
- Risk: Interaction logic not tested
- Priority: Medium

**Skipped Tests:**
- What's not tested: `src/components/chat/use-todo-tracker.ts` has skipped tests
- Files: `src/components/chat/use-todo-tracker.ts`
- Risk: Todo tracking functionality may have untested edge cases
- Priority: Low

**Integration Tests:**
- What's not tested: End-to-end flows (project creation, workspace initialization, Claude session lifecycle)
- Risk: Multi-component interactions not verified
- Priority: Medium

**tRPC Routers:**
- What's not tested: Most tRPC routers lack dedicated test files except `workspace.trpc.test.ts`
- Files: `src/backend/trpc/project.trpc.ts`, `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/admin.trpc.ts`
- Risk: API contract regressions
- Priority: High

---

*Concerns audit: 2026-01-31*
