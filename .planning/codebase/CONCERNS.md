# Codebase Concerns

**Analysis Date:** 2026-02-10

## Tech Debt

**In-Memory State Not Shared Across Processes:**
- Issue: Multiple in-memory Maps track critical state (locks, sessions, terminals) that isn't shared between Node.js processes. File-based persistence helps on restart but doesn't provide cross-process synchronization during runtime.
- Files: `src/backend/services/file-lock.service.ts` (lines 13-16), `src/backend/services/session.process-manager.ts` (multiple Map fields), `src/backend/services/terminal.service.ts` (line 77-86), `src/backend/services/worktree-lifecycle.service.ts` (lines 24, 27)
- Impact: If the application ever scales to multiple processes or restarts frequently, file locks, session state, and terminal references may become stale or inconsistent
- Fix approach: Consider Redis or shared lock files for cross-process coordination. Document single-process assumption clearly in server startup

**Unsafe Type Coercion Throughout Codebase:**
- Issue: 92 uses of `as any`, `as unknown`, or the `unsafeCoerce` utility function that bypasses TypeScript's type system
- Files: `src/test-utils/unsafe-coerce.ts` (defined but used extensively across backend)
- Impact: Loses type safety guarantees, making code vulnerable to runtime errors that TypeScript could catch at compile time
- Fix approach: Eliminate uses of `unsafeCoerce`. Use proper Zod schemas and type guards instead. This is particularly important in data serialization/deserialization paths

**JSON.parse Without Comprehensive Error Handling:**
- Issue: Multiple locations parse JSON without schema validation in fallback paths
- Files: `src/backend/services/file-lock.service.ts` (line 248), `src/backend/services/worktree-lifecycle.service.ts` (line 337), `src/backend/claude/protocol.ts` (line 500), `src/backend/claude/session.ts` (lines 85, 154)
- Impact: Malformed JSON silently falls back to empty state or defaults. Could mask data corruption or partial initialization issues
- Fix approach: Always validate JSON.parse output with schemas. Log failures explicitly rather than silently degrading

**Static Maps in Service Classes:**
- Issue: Services like `RunScriptService` use `static` class-level Maps to store process references, output buffers, and listeners
- Files: `src/backend/services/run-script.service.ts` (lines 19-25)
- Impact: Makes testing difficult, creates global state, prevents instance-level isolation
- Fix approach: Refactor to instance-based services with dependency injection instead of static state

**Resume Mode Lock Implementation with Manual Synchronization:**
- Issue: Resume mode tracking uses file-based locks with manual retry logic, stale threshold configuration, and multiple cleanup paths
- Files: `src/backend/services/worktree-lifecycle.service.ts` (lines 29-36, 72-80)
- Impact: Complex state machine for something that could be simpler. Risk of deadlock or stale lock accumulation if timing assumptions break
- Fix approach: Consider using a proper locking library or simplifying the resume mode logic

## Known Bugs

**Resource Cleanup Error Handling is Inconsistent:**
- Symptoms: Error handlers that silently catch and ignore cleanup failures (e.g., file handle closing, process termination)
- Files: `src/backend/services/terminal.service.ts`, `src/backend/services/session-file-logger.service.ts`, `src/backend/services/session.process-manager.ts` (comments about ignoring disposal errors)
- Trigger: Process termination, terminal disconnection, or file operations failing during cleanup
- Workaround: None - errors are silently suppressed. If cleanup fails, resources may leak

**Race Condition in Resume Mode File Lock:**
- Symptoms: File-based lock could be removed by one process while another still holds it (inode mismatch detection)
- Files: `src/backend/services/worktree-lifecycle.service.ts` (lines 72-80, lock stale threshold logic)
- Trigger: Multiple processes accessing same workspace simultaneously or clock skew
- Workaround: Current code uses 25-second stale threshold (5x acquire timeout) to minimize false positives, but timing is fragile

**Run Script Process Exit Handler State Race:**
- Symptoms: Process exit event handler checks workspace state and transitions it, but this could race with concurrent operations
- Files: `src/backend/services/run-script.service.ts` (lines 106-149, exit handler)
- Trigger: Rapid start/stop of run script or state machine transitions happening concurrently with exit event
- Workaround: State machine transitions check current state before progressing, so most races are caught. But error handling just warns and continues

## Security Considerations

**Shell Command Execution via spawn:**
- Risk: Commands passed to `spawn('bash', ['-c', command], ...)` are user-provided and could be exploited if not validated
- Files: `src/backend/services/run-script.service.ts` (line 86), `src/backend/services/startup-script.service.ts` (line 204)
- Current mitigation: Commands come from Prisma-stored configuration and workspace setup, not direct user input. But no validation of command content (e.g., forbidden patterns)
- Recommendations: Add allowlist of command patterns or run in restricted environment. Document security assumption that stored commands are trustworthy

**GitHub CLI Authentication:**
- Risk: Uses local `gh` CLI authentication, which relies on system credential storage
- Files: `src/backend/services/github-cli.service.ts` (numerous `gh` invocations)
- Current mitigation: Assumes `gh auth` is already configured on the system. No validation that auth succeeded
- Recommendations: Add explicit auth validation at startup. Consider caching auth status to avoid repeated failures

**Command Substitution in Run Script:**
- Risk: Run script command can contain `{port}` placeholder that gets substituted
- Files: `src/backend/services/run-script.service.ts` (lines 70-77)
- Current mitigation: Only `{port}` is substituted; other placeholders are not processed
- Recommendations: Document supported placeholders clearly. Consider whitelist approach for future placeholders

**Workspace Path Traversal:**
- Risk: File operations use user-provided file paths which could contain `..` to escape worktree
- Files: `src/backend/services/file-lock.service.ts` (normalizes paths), `src/backend/trpc/workspace/git.trpc.ts` (validates with "Invalid file path")
- Current mitigation: File lock service normalizes paths with `path.normalize()` and strips leading slashes. Git trpc validates paths
- Recommendations: Add explicit validation that normalized paths stay within worktree bounds. Use `path.resolve()` and `path.relative()` to verify containment

## Performance Bottlenecks

**GitHub CLI Service JSON Parsing:**
- Problem: Large PR diffs can be up to 10MB and are parsed and validated with Zod schemas synchronously
- Files: `src/backend/services/github-cli.service.ts` (lines 28-30: 10MB buffer, line 310-330: parseGhJson function)
- Cause: `JSON.parse()` blocks the event loop for large payloads
- Improvement path: Consider streaming JSON parsing for diff operations or chunking large diffs. Add progress indicator to UI for large operations

**Terminal Output Buffer Unbounded Growth:**
- Problem: Terminal output buffers accumulate data with only soft size limit (100KB per terminal) that gets trimmed after reaching capacity
- Files: `src/backend/services/terminal.service.ts` (lines 93), but buffer management logic needs review
- Cause: If terminal produces output faster than trimming happens, buffer could exceed limit temporarily
- Improvement path: Implement ring buffer or limit total terminals per workspace. Add metrics to monitor buffer sizes

**Workspace State Machine Queries:**
- Problem: State machine transitions query workspace by ID multiple times in sequence (read for validation, update for transition)
- Files: `src/backend/services/workspace-state-machine.service.ts`
- Cause: Each state transition is separate database call pattern
- Improvement path: Use transactional updates or batch queries when multiple transitions happen in sequence

**Ratchet Service PR Polling:**
- Problem: Ratchet service polls all workspaces with PRs on an interval, making GitHub CLI calls for each workspace
- Files: `src/backend/services/ratchet.service.ts` (polling loop using `SERVICE_INTERVAL_MS`)
- Cause: GitHub API rate limiting could become bottleneck with many workspaces
- Improvement path: Implement exponential backoff and caching. Consider webhook-based PR updates instead of polling

## Fragile Areas

**GitHub CLI Service - External Command Dependency:**
- Files: `src/backend/services/github-cli.service.ts` (all operations)
- Why fragile: Entire GitHub integration depends on system `gh` CLI being installed and authenticated. If `gh` changes output format, many operations break silently due to Zod validation errors
- Safe modification: All changes to gh command invocation must include test cases with mocked output. Add integration tests that validate against real GitHub API output format periodically
- Test coverage: 57 test files exist but github-cli.service.test.ts tests are comprehensive with JSON schema validation tests

**File Lock Service Cross-Process Behavior:**
- Files: `src/backend/services/file-lock.service.ts` (persistence, inode tracking)
- Why fragile: File-based locking with inode tracking is fragile across filesystem types (NFS vs local) and different OS implementations. Stale lock detection is timing-dependent
- Safe modification: Any changes to lock expiration or stale detection must be accompanied by analysis of timing guarantees. Add filesystem-specific testing
- Test coverage: Comprehensive file-lock.service.test.ts exists with mocked fs operations

**Resume Mode File Lock with Manual Cleanup:**
- Files: `src/backend/services/worktree-lifecycle.service.ts` (lines 29-150, especially lock functions)
- Why fragile: Manual lock file creation, inode verification, and cleanup is error-prone. Relies on `fs.rename` atomicity which varies by filesystem
- Safe modification: Keep lock acquisition and release as separate, clear functions. Any changes to retry logic or stale threshold must include detailed comments explaining timing assumptions
- Test coverage: Test coverage exists but consider adding stress tests with concurrent lock attempts

**Terminal Resource Monitoring Interval:**
- Files: `src/backend/services/terminal.service.ts` (lines 124-150, monitoring setup)
- Why fragile: Terminal monitoring uses `setInterval` that could accumulate if monitoring callback takes longer than interval
- Safe modification: Ensure monitoring callback is wrapped in try-catch and completed before next interval fires. Use `setTimeout` recursion pattern instead of `setInterval`
- Test coverage: Interval management is not extensively tested in provided test files

## Scaling Limits

**Database - SQLite Concurrency:**
- Current capacity: SQLite with default single-writer limit
- Limit: High concurrent write load will hit SQLite's writer queue limit
- Scaling path: Migrate to PostgreSQL if concurrent workspace creation/session updates become bottleneck. Add connection pooling (currently missing)

**Terminal Processes Per Workspace:**
- Current capacity: Unlimited terminals per workspace stored in Map
- Limit: Memory usage grows linearly with terminal count. Resource monitoring loop O(n) per workspace
- Scaling path: Add configurable limit on terminals per workspace (e.g., max 5). Implement lazy resource monitoring only for active terminals

**File Lock Storage:**
- Current capacity: In-memory Maps + file-based persistence for advisory locks
- Limit: 10,000+ locked files per workspace will cause memory overhead and slow persistence operations
- Scaling path: Implement cleanup of expired locks more aggressively. Consider hash-based file organization for lock persistence

**GitHub API Rate Limits:**
- Current capacity: Ratchet service polls all workspaces on interval (SERVICE_INTERVAL_MS)
- Limit: GitHub API has 5,000 requests/hour limit. With 100+ workspaces checking PRs, could exceed quota
- Scaling path: Implement exponential backoff with RateLimitBackoff (already exists). Add webhook support for real-time PR updates. Batch PR status requests where possible

**Chat Session Process Count:**
- Current capacity: Session process manager maintains ClaudeClient instances in Maps per session
- Limit: Node.js process handles ~10,000 open file descriptors by default. Each Claude process spawns shell + file access
- Scaling path: Implement process pooling or recycling. Add configurable MAX_SESSIONS_PER_WORKSPACE (already in config, see `src/backend/services/config.service.ts` line 341)

## Dependencies at Risk

**node-pty for Terminal Support:**
- Risk: Native module dependency that may not compile on all platforms/Node versions
- Impact: If node-pty fails to build, terminal feature is completely unavailable (code has graceful fallback but feature is broken)
- Files: `src/backend/services/terminal.service.ts` (runtime require fallback on lines 125-138)
- Migration plan: Already has graceful degradation (logs warning if native module missing). Document terminal feature as optional

**tree-kill for Process Cleanup:**
- Risk: External process tree termination may not work on all OSes, especially Windows
- Impact: Run script processes might not fully terminate, leaving zombie processes
- Files: `src/backend/services/run-script.service.ts` (import line 2)
- Migration plan: tree-kill is well-maintained but consider platform detection tests. Add integration tests on Windows/Linux/macOS

**GitHub CLI (gh command):**
- Risk: System dependency not bundled. If gh is not installed or updated, GitHub features fail
- Impact: Entire GitHub integration is unavailable
- Files: `src/backend/services/github-cli.service.ts` (all operations)
- Migration plan: Could fallback to Octokit SDK instead of gh CLI, but would be significant refactor. Document gh installation requirement prominently

## Missing Critical Features

**No Webhook Support for GitHub Events:**
- Problem: Application polls GitHub API for PR changes instead of receiving webhooks. Creates latency and API usage waste
- Blocks: Real-time PR updates, efficient auto-fix triggering, timely review notifications
- Workaround: Currently uses polling interval (visible in ratchet service). Acceptable for small deployments

**No Distributed Lock Mechanism:**
- Problem: File locks are single-process only. Cannot coordinate between multiple Node.js processes
- Blocks: Horizontal scaling, process isolation, reliable multi-machine deployment
- Workaround: Currently assumes single process. Works for desktop app but limits server deployments

**No Persistent Session State Across Server Restarts:**
- Problem: Claude sessions are tracked in memory and Maps. Session state is lost if server restarts during active session
- Blocks: Robust handling of server updates/crashes with active user sessions
- Workaround: Client reconnects trigger new session creation

**No Configuration Validation at Startup:**
- Problem: Many required environment variables and feature flags are parsed at runtime (config.service.ts)
- Blocks: Detecting misconfiguration early instead of at runtime
- Workaround: Document all required settings in comments

## Test Coverage Gaps

**GitHub CLI Service Integration:**
- What's not tested: Real github API integration (only mocked). Command output format changes would not be caught until runtime
- Files: `src/backend/services/github-cli.service.ts` and corresponding .test.ts
- Risk: GitHub API output format changes break parsing silently
- Priority: High - GitHub integration is critical path for PR features

**File-Based Lock Stale Detection Logic:**
- What's not tested: Actual filesystem behavior across NFS, concurrent process scenarios, clock skew situations
- Files: `src/backend/services/file-lock.service.ts` (inode tracking, stale threshold)
- Risk: Locks could accumulate if stale threshold is miscalibrated
- Priority: Medium - only critical if multi-process deployment is planned

**Terminal Cleanup Under Load:**
- What's not tested: Resource monitoring loop behavior when terminals are created/destroyed rapidly
- Files: `src/backend/services/terminal.service.ts` (monitoring setup and resource updates)
- Risk: Memory leak if terminals don't clean up listeners properly
- Priority: Medium - only shows under high load with many terminal sessions

**Race Conditions in State Machines:**
- What's not tested: Concurrent state transitions when multiple sessions/workspaces transition simultaneously
- Files: `src/backend/services/workspace-state-machine.service.ts`, `src/backend/services/run-script-state-machine.service.ts`
- Risk: Invalid state transitions slip through if concurrency assumptions break
- Priority: Medium - rare but could cause undefined behavior

**Session Process Manager Crash Scenarios:**
- What's not tested: Behavior when Claude process crashes during message send or while handling interrupt
- Files: `src/backend/services/session.process-manager.ts`
- Risk: Session state becomes inconsistent with actual process state
- Priority: High - crashes should be handled gracefully

---

*Concerns audit: 2026-02-10*
