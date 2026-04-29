# Codebase Concerns

**Analysis Date:** 2026-04-29

## Tech Debt

**Codex ACP adapter schema drift:**
- Issue: The checked-in Codex app-server method snapshot does not match the installed `codex` CLI. `pnpm check:codex-schema` reports expected `codex-cli 0.101.0` and detected `codex-cli 0.125.0`, with many changed client methods and new server request methods.
- Files: `scripts/check-codex-schema-drift.mjs`, `src/backend/services/session/service/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json`, `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/protocol-permission-handler.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts`
- Impact: Current Codex app-server requests such as `item/permissions/requestApproval` and `mcpServer/elicitation/request` are outside the local Zod schemas and can fail as unsupported requests instead of producing normal permission or input flows.
- Fix approach: Update the schema snapshot against the supported `codex` CLI version, add handlers for new server request methods, and add adapter tests that exercise permission, filesystem, MCP, and shell-command request paths.

**ACP runtime compatibility shims:**
- Issue: The ACP runtime mutates incoming session update payloads before SDK validation to compensate for malformed `claude-agent-acp` location line values.
- Files: `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Impact: Protocol compatibility behavior is embedded in the runtime manager and depends on manual payload normalization with casts.
- Fix approach: Keep compatibility logic isolated behind a named normalizer, cover it with focused tests, and remove it only when the upstream provider contract is verified.

**In-memory runtime state:**
- Issue: Active sessions, terminals, process handles, output buffers, advisory locks, and workspace snapshots live primarily in process memory.
- Files: `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/terminal/service/terminal.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/session/service/store/file-lock.service.ts`, `src/backend/services/workspace-snapshot-store.service.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`
- Impact: Server restart or multi-process deployment loses live process handles, pending permission prompts, active terminal state, in-memory output listeners, and event coalescing state. The file lock service explicitly coordinates only within a single Node process.
- Fix approach: Treat the backend as single-process in deployment docs, persist only authoritative state, reconcile process-backed state on startup, and use a real distributed lock if multiple server processes are introduced.

**Shell execution safety policy has exceptions:**
- Issue: `src/backend/lib/shell.ts` documents the preferred safe execution layer, but run scripts, startup scripts, auto-iteration tests, terminals, and ACP providers intentionally execute configured shell commands or subprocesses directly.
- Files: `src/backend/lib/shell.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`, `src/backend/services/terminal/service/terminal.service.ts`, `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Impact: Arbitrary project-defined commands run through `bash -c` or interactive shells, inherit broad environment by default, and are easy to expand without a shared risk checklist.
- Fix approach: Document these as trusted-command boundaries, centralize environment filtering and logging redaction, and add tests for command validation, process cleanup, and timeout behavior.

**Large service and orchestration modules:**
- Issue: Several production modules exceed 1,000 lines and combine state transitions, process management, external calls, and persistence.
- Files: `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/services/session/service/lifecycle/session.config.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`, `src/cli/proxy.ts`, `src/client/routes/admin-page.tsx`, `src/components/chat/chat-input/chat-input.tsx`
- Impact: Behavioral changes require broad review, test setup is heavy, and small fixes can accidentally alter unrelated state paths.
- Fix approach: Extract process lifecycle, provider negotiation, permission bridging, and UI subpanels into narrower modules with tests around each extracted boundary.

**Custom migration runner limitations:**
- Issue: The Electron migration runner parses SQL line by line and rejects multiline string literals.
- Files: `src/backend/migrate.ts`, `prisma/migrations/`
- Impact: Prisma-generated or hand-written migrations that rely on multiline string literals can fail in the packaged app even if they pass the normal Prisma CLI workflow.
- Fix approach: Keep migration SQL simple, add CI coverage that runs `src/backend/migrate.ts` against a temporary SQLite database, and document unsupported SQL constructs near migration authoring guidance.

## Known Bugs

**Codex schema drift check fails:**
- Symptoms: `pnpm check:codex-schema` reports method drift and a CLI version mismatch.
- Files: `scripts/check-codex-schema-drift.mjs`, `src/backend/services/session/service/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json`
- Trigger: Run `pnpm check:codex-schema` with the currently installed `codex` CLI.
- Workaround: Pin the expected `codex` CLI version or update the snapshot and adapter implementation together.

**Unsupported Codex server requests fail closed:**
- Symptoms: Unknown Codex app-server request payloads return an unsupported-request error instead of entering the app permission UI.
- Files: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/protocol-permission-handler.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/codex-rpc-client.ts`
- Trigger: A newer Codex app-server emits request methods not represented in `KnownServerRequestSchema`.
- Workaround: Keep the CLI pinned to the snapshot version until the adapter supports the new methods.

**Ratchet timeout does not cancel underlying checks:**
- Symptoms: A workspace check can time out and clear its in-flight marker while the underlying async GitHub or workspace operation continues.
- Files: `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/services/github/service/github-cli.service.ts`
- Trigger: Slow `gh` calls or a long ratchet check that exceeds the workspace check timeout.
- Workaround: The per-workspace in-flight map reduces duplicate checks during the timeout window, but the timed-out operation is not cancelled.

**Run-script stop can leave descendant processes:**
- Symptoms: A process tree that ignores `SIGTERM` can keep running after stop returns or after process exit cleanup.
- Files: `src/backend/services/run-script/service/run-script.service.ts`
- Trigger: Run scripts, cleanup scripts, or post-run scripts that fork child processes or ignore termination.
- Workaround: Normal stop uses `tree-kill` with `SIGTERM`; synchronous server-exit cleanup kills only the direct child with `SIGKILL`.

**Snapshot reconciliation concurrency comment does not match code:**
- Symptoms: The comment says git stats use `p-limit(3)`, while the code sets `GIT_CONCURRENCY = 10`.
- Files: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Trigger: Read or tune snapshot reconciliation behavior.
- Workaround: Treat the constant as authoritative and update the comment when changing reconciliation load.

## Security Considerations

**Backend API and WebSockets are unauthenticated:**
- Risk: Any caller that can reach the backend can invoke public tRPC procedures and WebSocket handlers for projects, sessions, terminals, setup terminals, dev logs, post-run logs, and snapshots.
- Files: `src/backend/trpc/trpc.ts`, `src/backend/trpc/procedures/project-scoped.ts`, `src/backend/server.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/trpc/linear.trpc.ts`, `src/cli/proxy.ts`
- Current mitigation: CORS defaults are localhost-oriented, project-scoped procedures require an `X-Project-Id` header, and `src/cli/proxy.ts` provides a private proxy mode.
- Recommendations: Add backend authentication for HTTP and WebSocket upgrades, make project access authorization explicit, reject non-loopback exposure unless auth is configured, and keep `ff proxy` private mode as the default remote access path.

**Project-defined commands inherit the server environment:**
- Risk: Run scripts, startup scripts, auto-iteration test commands, terminal shells, and ACP agent subprocesses can read any secret present in the server process environment.
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`, `src/backend/services/terminal/service/terminal.service.ts`, `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Current mitigation: The app is local-first, permissions are configurable, startup script file paths are constrained to the repository, and ACP permission prompts exist for strict flows.
- Recommendations: Use an environment allowlist for subprocesses, redact command logs, warn before running repository-supplied commands, and avoid putting durable API keys in the backend process environment.

**Ratchet defaults can run high-permission automated sessions:**
- Risk: Ratchet/autofix sessions default to broad permissions and operate on PR, CI, and review-comment content that may be authored by untrusted contributors.
- Files: `prisma/schema.prisma`, `src/backend/services/session/service/lifecycle/session.config.service.ts`, `src/backend/services/session/service/acp/acp-client-handler.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`
- Current mitigation: Workspace-level ratchet toggles and settings control default permissions; strict and relaxed modes are available.
- Recommendations: Make high-permission ratchet behavior opt-in per trusted project, record the effective permission preset in session metadata, and gate autofix on repository trust rules.

**Linear API key encryption key is stored beside local data:**
- Risk: A backup or compromise of the app base directory can include both encrypted Linear API keys and the local encryption key.
- Files: `src/backend/services/crypto.service.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/trpc/linear.trpc.ts`, `prisma/schema.prisma`
- Current mitigation: API keys are encrypted with AES-256-GCM and new key files are written with `0600` permissions.
- Recommendations: Validate permissions on existing key files at startup, support OS keychain or externally supplied encryption keys, and document backup handling for `encryption.key`.

**Bearer tokens appear in proxy URLs:**
- Risk: Private proxy and run-script proxy direct links include bearer tokens in URLs that can be copied, saved in shell history, or exposed through browser history.
- Files: `src/cli/proxy.ts`, `src/backend/services/run-script-proxy.service.ts`, `src/shared/proxy-utils.ts`
- Current mitigation: Tokens are random, token query parameters are stripped before proxying, and authenticated sessions switch to signed `HttpOnly` cookies.
- Recommendations: Prefer password entry links over direct token links, rotate tokens when tunnels restart or after first use, and avoid logging token-bearing URLs outside explicit user-facing output.

## Performance Bottlenecks

**Ratchet polling scales with active PR workspaces:**
- Problem: Each scheduler cycle fetches all READY workspaces with PRs and queues checks with `Promise.all`.
- Files: `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/services/github/service/github-cli.service.ts`
- Cause: Workspaces are checked by polling instead of webhook-driven events, and timed-out checks are not cancelled.
- Improvement path: Add bounded per-cycle concurrency, cancellation with `AbortSignal`, webhook/event triggers, and metrics for queue length and check duration.

**Snapshot reconciliation does git work for all active workspaces:**
- Problem: Periodic reconciliation computes workspace runtime state and git stats for all non-archived workspaces.
- Files: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`, `src/backend/services/workspace-snapshot-store.service.ts`
- Cause: Reconciliation is authoritative and uses a fixed git concurrency value.
- Improvement path: Reconcile dirty workspaces preferentially, tune `GIT_CONCURRENCY`, and expose reconciliation duration metrics.

**Repository file autocomplete can walk large repos:**
- Problem: File listing recursively scans a project repository, then filters and sorts before returning a limited result set.
- Files: `src/backend/trpc/project.trpc.ts`
- Cause: The implementation enumerates filesystem entries directly for each request.
- Improvement path: Add cancellation, cache indexed file paths per project, skip large ignored directories aggressively, and enforce a traversal budget before sorting.

**Terminal resource monitoring is O(active terminals):**
- Problem: The terminal service polls resource usage for all active terminals every five seconds.
- Files: `src/backend/services/terminal/service/terminal.service.ts`
- Cause: A single interval walks every active terminal and calls process resource inspection.
- Improvement path: Add global and per-workspace terminal limits, prevent overlapping resource polls, and degrade resource collection under load.

**Command output buffers can grow under concurrent workloads:**
- Problem: Run scripts, startup scripts, auto-iteration tests, and terminals all buffer output in memory or database fields with separate caps.
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`, `src/backend/services/terminal/service/terminal.service.ts`, `prisma/schema.prisma`
- Cause: Output capture is local to each subsystem and not globally budgeted.
- Improvement path: Track total output memory per workspace, stream large logs to files, and store only bounded excerpts in Prisma.

## Fragile Areas

**ACP provider runtime and Codex adapter:**
- Files: `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/session/service/acp/acp-client-handler.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/`
- Why fragile: It bridges multiple evolving protocols, subprocess lifecycle, permission approval semantics, JSON-RPC message parsing, and provider-specific workarounds.
- Safe modification: Run `pnpm check:codex-schema`, add fixtures for new provider payloads, test unknown request handling, and verify strict, relaxed, and yolo permission modes.
- Test coverage: Adapter unit tests exist, but the currently failing schema drift check indicates compatibility coverage is not current with the installed CLI.

**Run-script state machine:**
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`
- Why fragile: Start, stop, cleanup, post-run, output listeners, database state, PID handling, and race recovery are interleaved in one service.
- Safe modification: Add regression tests for concurrent start/stop, fast-exiting commands, commands that ignore `SIGTERM`, cleanup timeouts, and server restart recovery.
- Test coverage: Unit tests cover core run-script behavior, but OS-level process tree and restart scenarios need targeted coverage.

**Advisory file locking:**
- Files: `src/backend/services/session/service/store/file-lock.service.ts`
- Why fragile: Locks are in-memory for coordination and persisted only as advisory restart metadata; persistence errors are logged and do not fail acquisition.
- Safe modification: Preserve single-process assumptions, fail loud on malformed lock files only where user action is required, and introduce a database-backed lock before multi-process deployment.
- Test coverage: Add tests for persistence failure, stale lock cleanup, and multi-process warning paths.

**Workspace snapshots and event coalescing:**
- Files: `src/backend/services/workspace-snapshot-store.service.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Why fragile: Derived UI state depends on event ordering, timestamp-based field merges, periodic reconciliation, and in-memory indexes.
- Safe modification: Prefer authoritative database writes for durable state, keep event payloads small, and test merge ordering with out-of-order timestamps.
- Test coverage: Add reconciliation tests for archived workspaces, hidden READY workspaces, terminal/session state changes, and delayed git stats.

**Custom migration execution:**
- Files: `src/backend/migrate.ts`, `prisma/schema.prisma`, `prisma/migrations/`
- Why fragile: Packaged-app migrations do not use Prisma's normal runner directly and have parser constraints.
- Safe modification: Run migrations through both Prisma CLI and `src/backend/migrate.ts` before shipping schema changes.
- Test coverage: Add a fixture migration suite that exercises comments, blank lines, PRAGMA statements, and unsupported multiline strings.

## Scaling Limits

**SQLite local database:**
- Current capacity: Suitable for local single-user operation with moderate projects, workspaces, sessions, terminal output, and ratchet state.
- Limit: SQLite write contention grows with concurrent sessions, run-script output writes, terminal state updates, auto-iteration progress, and ratchet polling.
- Scaling path: Keep local-first defaults, batch high-frequency writes, move large logs out of Prisma, and consider a server database only with auth and distributed locking.

**Single-process runtime model:**
- Current capacity: One backend process owns ACP sessions, terminals, run scripts, file locks, and snapshot events.
- Limit: Multiple Node processes cannot share live process handles or advisory locks.
- Scaling path: Add a durable process registry, database/distributed locks, external queues, and explicit leader election before horizontal scaling.

**External CLI dependencies:**
- Current capacity: GitHub, tunnel, terminal, and process-tree operations depend on local CLIs or native modules.
- Limit: Missing or changed `gh`, `cloudflared`, `node-pty`, native SQLite modules, or `tree-kill` behavior breaks features at runtime.
- Scaling path: Add startup diagnostics, version checks, graceful feature degradation, and installation repair guidance.

**Workspace process count:**
- Current capacity: Session count is configurable, but terminals, run scripts, startup scripts, post-run scripts, tests, and agent subprocesses share local CPU, memory, PTYs, and file descriptors.
- Limit: No single global scheduler budgets all workspace subprocesses together.
- Scaling path: Track all subprocesses per workspace, enforce global process limits, and surface backpressure in the UI.

## Dependencies at Risk

**`codex` CLI app-server protocol:**
- Risk: The local adapter trails the installed CLI schema.
- Impact: Permission prompts, filesystem operations, MCP requests, and shell-command flows can fail or be silently unsupported.
- Migration plan: Pin supported CLI versions in development, regenerate snapshots on upgrade, and land adapter handlers in the same change as schema updates.

**`@agentclientprotocol/claude-agent-acp`:**
- Risk: The runtime contains a provider-specific compatibility workaround for malformed location line fields.
- Impact: Removing or changing the workaround without fixture coverage can break message validation.
- Migration plan: Keep provider payload fixtures and delete the workaround only after upstream behavior is verified.

**`gh` CLI:**
- Risk: GitHub integration relies on local authentication, command output shape, and CLI rate-limit behavior.
- Impact: Issue fetch, PR status, ratchet checks, comments, and auto-fix workflows degrade when `gh` changes or loses auth.
- Migration plan: Keep `gh` health checks, parse output defensively, and consider direct GitHub API clients for high-volume ratchet paths.

**`cloudflared`:**
- Risk: Remote access and run-script tunnels require a local `cloudflared` binary and stable output parsing.
- Impact: Proxy features fail when the binary is missing, unavailable, or output format changes.
- Migration plan: Improve diagnostics, pin tested versions where packaged, and keep a local-only fallback path clear in the UI.

**Native modules (`better-sqlite3`, `node-pty`):**
- Risk: Native modules can break after Node, Electron, or platform upgrades.
- Impact: Database access and terminal sessions can fail at startup or packaging time.
- Migration plan: Keep `scripts/ensure-native-modules.mjs`, postinstall checks, and packaged-app smoke tests current.

## Missing Critical Features

**Backend authorization layer:**
- Problem: Project scoping is header-based and does not authenticate callers.
- Blocks: Safe non-local hosting, team deployments, and secure public tunnels.

**Webhook-driven ratchet updates:**
- Problem: Ratchet relies on polling GitHub PR state and review comments.
- Blocks: Low-latency autofix at scale and efficient API usage across many workspaces.

**Durable operation cancellation:**
- Problem: Timed-out ratchet checks and many spawned commands do not share a unified cancellation contract.
- Blocks: Reliable cleanup under slow external APIs, hung subprocesses, and server shutdown.

**Central subprocess security policy:**
- Problem: Multiple services independently decide environment inheritance, command logging, timeouts, and process-tree cleanup.
- Blocks: Consistent hardening for run scripts, startup scripts, tests, terminals, and agent providers.

**External secret/key management:**
- Problem: Local encrypted settings depend on a local key stored in the same app data area.
- Blocks: Strong protection for synced or backed-up app data directories.

## Test Coverage Gaps

**Current Codex CLI compatibility:**
- What's not tested: End-to-end behavior against the installed `codex` app-server schema and new request methods.
- Files: `src/backend/services/session/service/acp/codex-app-server-adapter/`, `scripts/check-codex-schema-drift.mjs`
- Risk: Permission and MCP flows break after CLI upgrades.
- Priority: High

**Unauthenticated backend exposure:**
- What's not tested: HTTP and WebSocket rejection behavior for unauthenticated remote callers.
- Files: `src/backend/server.ts`, `src/backend/trpc/trpc.ts`, `src/backend/trpc/procedures/project-scoped.ts`
- Risk: Future deployment or proxy changes expose full local control surfaces.
- Priority: High

**Process lifecycle edge cases:**
- What's not tested: Process trees that ignore `SIGTERM`, fork children, exit during stop, or leave stale PIDs after restart.
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`, `src/backend/services/terminal/service/terminal.service.ts`
- Risk: Orphaned processes, sticky states, and misleading UI status.
- Priority: High

**Multi-process locking assumptions:**
- What's not tested: Two backend processes acquiring or persisting advisory locks for the same session context.
- Files: `src/backend/services/session/service/store/file-lock.service.ts`
- Risk: Concurrent agents edit the same context files when deployment assumptions change.
- Priority: Medium

**Large workspace load:**
- What's not tested: Hundreds of workspaces, many active terminals, many ratchet PRs, and large repositories under snapshot reconciliation.
- Files: `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/services/terminal/service/terminal.service.ts`
- Risk: Slow UI updates, API rate-limit pressure, and high local CPU usage.
- Priority: Medium

**Packaged-app migration parity:**
- What's not tested: Every Prisma migration running through the custom Electron migration runner.
- Files: `src/backend/migrate.ts`, `prisma/migrations/`
- Risk: A migration succeeds in development and fails in packaged app startup.
- Priority: Medium

---

*Concerns audit: 2026-04-29*
