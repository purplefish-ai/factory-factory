# Codebase Concerns

**Analysis Date:** 2026-05-17

## Tech Debt

**Large orchestration and runtime modules:**
- Issue: Several user-facing workflows are concentrated in very large modules that mix state transitions, external process control, persistence, event handling, and UI-facing mapping.
- Files: `src/client/routes/admin-page.tsx`, `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/services/session/service/lifecycle/session.config.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/components/chat/chat-input/components/input-controls.tsx`, `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/services/auto-iteration/service/auto-iteration.service.ts`
- Impact: Small behavior changes require reading broad files with many responsibilities, increasing regression risk around workspace startup, session runtime state, run-script lifecycle, auto-iteration, ratchet polling, and admin UI actions.
- Fix approach: Split by responsibility at existing boundaries: keep orchestration in `src/backend/orchestration/`, move capsule business rules under `src/backend/services/{name}/service/`, keep Prisma access in `src/backend/services/{name}/resources/`, and add focused Vitest coverage before extracting state-machine or process-control code.

**Runtime JSON configuration uses scattered schema validation and casts:**
- Issue: Auto-iteration configuration and progress are validated in some API paths but also passed through `unknown` casts and Prisma JSON conversions.
- Files: `src/backend/trpc/auto-iteration.trpc.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/orchestration/domain-bridges.orchestrator.ts`, `src/backend/services/workspace/service/creation.service.ts`, `src/backend/services/auto-iteration/service/logbook.service.ts`
- Impact: Corrupt or manually edited database JSON can reach runtime code with a shape that differs from UI/API assumptions, causing failed loop startup, wrong resume behavior, or incomplete progress recovery.
- Fix approach: Define shared Zod schemas for `AutoIterationConfig`, auto-iteration progress, and logbook data under `src/shared/` or the owning service capsule, then parse at every database boundary before orchestration or service code uses those values.

**Guardrail commands are split across optional scripts:**
- Issue: Important architectural checks are available but not all included in `pnpm check`.
- Files: `package.json`, `.dependency-cruiser.cjs`, `scripts/check-codex-schema-drift.mjs`, `scripts/check-critical-coverage.mjs`, `scripts/check-service-registry.ts`, `scripts/check-single-writer.mjs`
- Impact: Local and CI runs that use `pnpm check` enforce Biome, environment access, service registry ownership, and single-writer rules, but can miss dependency-boundary drift, Codex app-server schema drift, and critical coverage regressions.
- Fix approach: Add `pnpm deps:check`, `pnpm check:codex-schema`, and `pnpm check:coverage:critical` to the standard verification pipeline where runtime protocol and service-boundary changes are reviewed.

**Generated Prisma output dominates the repository and is lint-exempt:**
- Issue: Generated Prisma files are committed under `prisma/generated/` and excluded from Biome formatting/linting.
- Files: `prisma/generated/`, `biome.json`, `prisma/schema.prisma`, `scripts/check-service-registry.ts`
- Impact: Large generated files increase search noise and can hide accidental imports from generated internals. The service registry check is the primary protection for model ownership and cross-service access.
- Fix approach: Keep application imports pointed at `@prisma-gen/*` only where generated Prisma types or clients are needed, and keep model ownership enforced through `scripts/check-service-registry.ts`.

## Known Bugs

**Periodic task executions can remain RUNNING and block future schedules:**
- Symptoms: A periodic task with a RUNNING execution is skipped by later scheduler passes even if the associated workspace stops making progress without creating a PR.
- Files: `src/backend/services/periodic-task/service/periodic-task.service.ts`, `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`, `src/backend/services/workspace/resources/workspace.accessor.ts`
- Trigger: A periodic-task workspace remains in WORKING or WAITING and never creates a PR, while the execution row stays RUNNING. (READY workspaces with no active agent work are now auto-recovered after a 5-minute grace period.)
- Workaround: Manually archive or fail the workspace, or update the execution record so the scheduler can dispatch the next run.

**Periodic task dispatch advances schedule before workspace creation is durable:**
- Symptoms: `nextRunAt` can advance even when workspace creation or execution creation fails during dispatch.
- Files: `src/backend/services/periodic-task/service/periodic-task.service.ts`, `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`
- Trigger: `markDispatched` succeeds, then `createWorkspaceForTask` or execution creation throws.
- Workaround: Manually reset `nextRunAt` for the task and inspect logs from `src/backend/services/logger.service.ts`.

**Renamed and copied files are omitted from the structured diff list:**
- Symptoms: Workspace diff summaries can miss files when Git reports rename or copy status records.
- Files: `src/backend/trpc/workspace/git.trpc.ts`
- Trigger: `git diff --name-status` emits `R*` or `C*` status rows; the parser maps only added, modified, and deleted rows.
- Workaround: Use raw `git diff` output outside the structured UI for rename/copy-heavy changes.

**Untracked file diffs can allocate very large strings:**
- Symptoms: Requesting a diff for a large untracked file can create a large synthetic unified diff response.
- Files: `src/backend/trpc/workspace/git.trpc.ts`
- Trigger: `getFileDiff` sees no Git diff for an untracked file and reads the whole file as UTF-8 to construct a full added-file diff.
- Workaround: Avoid opening structured diffs for large untracked generated files; add ignore patterns before creating large artifacts in worktrees.

## Security Considerations

**Local API surface has no application-level authentication:**
- Risk: If the backend is bound to a reachable host or a permissive origin is configured, HTTP tRPC procedures and WebSocket handlers expose workspace, file, command, terminal, and agent-session capabilities to clients that can reach the server.
- Files: `src/backend/trpc/trpc.ts`, `src/backend/server.ts`, `src/backend/middleware/cors.middleware.ts`, `src/backend/middleware/security.middleware.ts`, `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/setup-terminal.handler.ts`, `src/backend/services/config.service.ts`
- Current mitigation: Defaults target local development origins, CORS allowlisting is centralized in `src/backend/middleware/cors.middleware.ts`, `setup-terminal` checks the Origin header, and private proxy mode has separate token handling in `src/cli/proxy.ts`.
- Recommendations: Add a required local session token or app-level auth layer for all tRPC and WebSocket routes, enforce Origin checks consistently across WebSocket handlers, and warn or block when binding beyond loopback without auth.

**Shell execution inherits broad environment state:**
- Risk: User-configured commands and agent/test commands run through `bash -c` with inherited `process.env`, which can expose local credentials to scripts and agent-controlled processes.
- Files: `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`, `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/config.service.ts`
- Current mitigation: Script path execution validates relative paths, commands run in workspace or worktree cwd, process timeouts exist, output buffers are capped in several paths, and `src/backend/lib/shell.ts` provides safer non-shell helpers for new code.
- Recommendations: Prefer `src/backend/lib/shell.ts` helpers for new fixed commands, add an environment allowlist or redaction layer for subprocesses, and keep `bash -c` limited to explicitly user-configured command fields.

**Debug and protocol logs can persist sensitive prompts, tool inputs, and command output:**
- Risk: Development logging writes raw WebSocket and ACP payloads to disk and structured server logging does not redact arbitrary object keys.
- Files: `src/backend/services/session/service/logging/session-file-logger.service.ts`, `src/backend/services/session/service/logging/acp-trace-logger.service.ts`, `src/backend/services/logger.service.ts`, `src/backend/services/config.service.ts`
- Current mitigation: WebSocket and ACP trace logs are configurable, default to development-oriented behavior, and include age-based cleanup.
- Recommendations: Add centralized redaction for common secret key names and token patterns, make raw payload logging explicitly opt-in, and ensure log directories are created with private permissions.

**Local encryption key protects Linear API keys but is a single recovery point:**
- Risk: Losing the local encryption key makes encrypted API keys undecryptable; host compromise that exposes both the database and key exposes those credentials.
- Files: `src/backend/services/crypto.service.ts`, `src/backend/orchestration/data-backup.service.ts`, `src/shared/schemas/issue-tracker-config.schema.ts`, `src/backend/services/linear/service/linear-config.service.ts`
- Current mitigation: AES-256-GCM is used, the key file is created with `0600` permissions, exports strip encrypted Linear API keys, and imports avoid machine-specific encrypted issue tracker config.
- Recommendations: Add key rotation and backup guidance, detect missing or invalid keys with a clear admin repair path, and keep exported backups free of encrypted credential blobs.

**Run-script proxy authentication uses URL tokens:**
- Risk: Proxy access tokens appear in authenticated URLs and can leak through browser history, copied links, referrers, or external logs when public proxy mode is enabled.
- Files: `src/backend/services/run-script-proxy.service.ts`, `src/shared/proxy-utils.ts`, `src/cli/proxy.ts`
- Current mitigation: Tokens are random, the proxy exchanges the token into an HTTP-only secure cookie, and the proxied path strips the query token.
- Recommendations: Prefer a one-time token exchange route, avoid displaying long-lived tokenized URLs, and add short token expiration for public proxy sessions.

## Performance Bottlenecks

**File listing traverses entire worktrees before applying limits:**
- Problem: `listAllFiles` recursively walks the worktree, then filters, sorts, and slices to the requested limit.
- Files: `src/backend/trpc/workspace/files.trpc.ts`, `src/backend/lib/file-helpers.ts`
- Cause: `listFilesRecursive` has depth and directory-skip controls but no max file count, timeout, or early-stop callback.
- Improvement path: Add traversal limits and pagination to `listFilesRecursive`, apply the caller limit during traversal, and return a truncation indicator when the result is incomplete.

**File reads check size after reading whole content:**
- Problem: `readFile` loads the full file into memory before truncating to the configured maximum size.
- Files: `src/backend/trpc/workspace/files.trpc.ts`, `src/backend/lib/file-helpers.ts`, `src/shared/limits.ts`
- Cause: The implementation stats the file but calls `fh.readFile()` before slicing to `MAX_FILE_SIZE`.
- Improvement path: Reject or stream files above the limit before reading content, and use range reads for previews.

**Run-script and startup output produce repeated database writes and in-memory buffers:**
- Problem: Long-running scripts stream output into debounced database appends and retain bounded output buffers/listeners in memory.
- Files: `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/workspace/resources/workspace.accessor.ts`
- Cause: Output is both persisted for workspace initialization and retained for active process UI state.
- Improvement path: Use persistent ring buffers with backpressure, batch database appends by byte size and time, and expose output cursors instead of replaying large accumulated strings.

**Ratchet and integration polling can concentrate API and database load:**
- Problem: Scheduler-driven ratchet checks and issue-provider workflows rely on repeated polling.
- Files: `src/backend/services/constants.ts`, `src/backend/services/scheduler.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/services/github/service/github-cli.service.ts`, `src/backend/services/linear/service/linear.service.ts`
- Cause: Workspaces and external providers are checked on fixed cadences, with retries and provider calls handled inside service workflows.
- Improvement path: Centralize provider request throttling, add exponential backoff for repeated failures, and record per-provider rate-limit state in the owning service capsule.

## Fragile Areas

**ACP runtime and adapter protocol compatibility:**
- Files: `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/session/service/acp/acp-client-handler.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/`, `scripts/check-codex-schema-drift.mjs`, `package.json`
- Why fragile: Runtime behavior depends on external ACP packages, spawned agent processes, schema compatibility, permission request handling, and provider-specific protocol quirks.
- Safe modification: Keep provider-specific handling inside `src/backend/services/session/service/acp/`, run `pnpm check:codex-schema` for Codex adapter changes, and add integration tests under `src/backend/services/session/service/acp/` for negotiation, permission, and resume behavior.
- Test coverage: Vitest and ACP integration tests exist, but real Codex app-server tests are manual through `pnpm test:codex-app-server:manual`.

**Workspace initialization and archive orchestration:**
- Files: `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/orchestration/workspace-archive.orchestrator.ts`, `src/backend/services/workspace/service/state-machine.service.ts`, `src/backend/services/workspace/resources/workspace.accessor.ts`, `scripts/check-single-writer.mjs`
- Why fragile: Workspace state transitions coordinate Git operations, issue providers, auto-iteration startup, periodic tasks, run scripts, and session creation.
- Safe modification: Route cross-service coordination through `src/backend/orchestration/`, keep direct database writes in the owning resource accessors, and run `pnpm check:ownership` after changing workspace fields.
- Test coverage: Integration tests cover service resources and selected WebSocket/session paths, but orchestration-level combinations are not uniformly covered across GitHub, Linear, periodic-task, and auto-iteration paths.

**In-memory runtime stores and process maps:**
- Files: `src/backend/services/session/service/session-domain.service.ts`, `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/auto-iteration/service/auto-iteration.service.ts`, `src/backend/server.ts`
- Why fragile: Active sessions, queued prompts, runtime clients, run-script processes, and auto-iteration loops live in process memory and are reconciled on server startup rather than resumed from a fully durable runtime log.
- Safe modification: Treat process restarts as a first-class behavior, persist enough runtime intent to make recovery deterministic, and keep startup cleanup in `src/backend/server.ts` aligned with each service's state machine.
- Test coverage: Unit and integration tests cover selected session and process flows, but crash/restart recovery has limited direct coverage.

**Process cleanup paths differ between graceful and synchronous shutdown:**
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`
- Why fragile: Graceful stop paths can use tree-kill and cleanup commands, while synchronous exit cleanup cannot run async cleanup scripts and may only kill direct child processes.
- Safe modification: Add signal-handling tests around child and grandchild processes, prefer process groups where supported, and document which cleanup guarantees apply to configured run scripts.
- Test coverage: Run-script behavior has service coverage, but OS signal, orphan process, and cleanup-script failure paths need targeted tests.

## Scaling Limits

**Single-process local SQLite architecture:**
- Current capacity: One Node/Electron or CLI server process owns the Prisma client and local SQLite database path.
- Limit: Multi-user, multi-host, or horizontally scaled deployment is not supported by the current database, process, WebSocket, and filesystem assumptions.
- Scaling path: Introduce a server-side auth model, move runtime state and queue ownership into durable services, and replace local-only process/session maps before supporting multiple backend instances.
- Files: `src/backend/db.ts`, `src/backend/server.ts`, `src/backend/services/config.service.ts`, `src/backend/services/session/service/session-domain.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/auto-iteration/service/auto-iteration.service.ts`

**Workspace file APIs assume local filesystem access:**
- Current capacity: File reads, screenshots, Git diffs, run scripts, and agent sessions operate against local worktree paths.
- Limit: Remote workspaces, sandboxed worker hosts, or object-storage-backed worktrees require a different file access contract.
- Scaling path: Add a workspace file service interface that supports streaming, path authorization, pagination, and remote execution before moving worktrees off local disk.
- Files: `src/backend/trpc/workspace/files.trpc.ts`, `src/backend/trpc/workspace/git.trpc.ts`, `src/backend/lib/file-helpers.ts`, `src/backend/services/workspace/resources/workspace.accessor.ts`

**Terminal and WebSocket fan-out is process-local:**
- Current capacity: WebSocket servers and session event emitters live in one backend process.
- Limit: Clients connected to different backend instances cannot share terminal/session streams without an external pub/sub layer.
- Scaling path: Introduce a broker for session deltas, terminal streams, and process lifecycle events before adding additional backend instances.
- Files: `src/backend/server.ts`, `src/backend/routers/websocket/terminal.handler.ts`, `src/backend/routers/websocket/chat.handler.ts`, `src/backend/services/session/service/session-domain.service.ts`

## Dependencies at Risk

**ACP packages and external agent CLIs:**
- Risk: Provider protocol changes can break session negotiation, permission requests, streaming deltas, or resume behavior.
- Impact: Claude and Codex sessions fail to start, lose history, or mishandle permission prompts.
- Migration plan: Keep adapter-specific compatibility code in `src/backend/services/session/service/acp/`, pin and upgrade `@agentclientprotocol/sdk` and `@agentclientprotocol/claude-agent-acp` deliberately, and run `pnpm check:codex-schema` plus ACP integration tests for upgrades.
- Files: `package.json`, `src/backend/services/session/service/acp/acp-runtime-manager.ts`, `src/backend/services/session/service/acp/codex-app-server-adapter/`, `scripts/check-codex-schema-drift.mjs`

**Native modules for SQLite, terminal, and Electron:**
- Risk: Native module rebuilds can fail across Node, Electron, and platform versions.
- Impact: Database access, pseudo-terminal sessions, or Electron startup can fail even when TypeScript builds pass.
- Migration plan: Keep `scripts/ensure-native-modules.mjs` in dev/test/start flows, run Electron rebuild commands when Node or Electron versions change, and include native-module smoke tests in release verification.
- Files: `package.json`, `scripts/ensure-native-modules.mjs`, `src/backend/db.ts`, `src/backend/routers/websocket/terminal.handler.ts`, `electron/`

**Cloudflared proxy binary availability:**
- Risk: Public run-script proxying depends on local cloudflared availability and external tunnel behavior.
- Impact: Proxy URLs fail to start or become unreachable while the underlying run script is healthy.
- Migration plan: Keep proxy startup errors visible in run-script state, add diagnostics for missing cloudflared, and isolate tunnel lifecycle from script lifecycle.
- Files: `src/backend/services/run-script-proxy.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`, `src/cli/proxy.ts`

## Missing Critical Features

**Auth boundary for non-local use:**
- Problem: The server has local-first CORS and proxy mitigations but no general authentication or authorization layer for tRPC and WebSocket APIs.
- Blocks: Safe shared-host, remote, or team deployments.
- Files: `src/backend/trpc/trpc.ts`, `src/backend/server.ts`, `src/backend/middleware/cors.middleware.ts`, `src/backend/routers/websocket/`

**Periodic task stale execution recovery and alerting:**
- Problem: Periodic task executions have no missed-run marker, retry budget, or failure notification channel. READY workspaces without active agent work are now recovered after a 5-minute grace period, but WORKING or WAITING workspaces that stall have no automatic recovery.
- Blocks: Reliable unattended recurring work.
- Files: `src/backend/services/periodic-task/service/periodic-task.service.ts`, `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`, `docs/design/periodic-tasks.md`

**Centralized secret redaction policy:**
- Problem: Logging, subprocess output, ACP traces, WebSocket traces, and run-script buffers do not share a single redaction layer.
- Blocks: Safe collection of diagnostics from workspaces that may use API keys, tokens, or private repository data.
- Files: `src/backend/services/logger.service.ts`, `src/backend/services/session/service/logging/session-file-logger.service.ts`, `src/backend/services/session/service/logging/acp-trace-logger.service.ts`, `src/backend/services/run-script/service/run-script.service.ts`

**Inngest large-payload safeguards are not represented in code:**
- Problem: Repository guidance defines an Inngest large-payload rule, but no Inngest functions or step helpers are detected in the current codebase.
- Blocks: Not applicable until Inngest is introduced; future Inngest code needs S3/link-based payload passing from the first implementation.
- Files: `AGENTS.md`, `package.json`, `src/backend/`

## Test Coverage Gaps

**Coverage thresholds are disabled and coverage focuses on backend paths:**
- What's not tested: Repository-wide minimum coverage is not enforced by Vitest configuration.
- Files: `vitest.config.ts`, `package.json`, `scripts/check-critical-coverage.mjs`
- Risk: Large UI, orchestration, and runtime changes can reduce coverage without failing the default test command.
- Priority: Medium

**Default verification excludes several high-value checks:**
- What's not tested: `pnpm test` does not run mobile Playwright E2E, real Codex app-server manual integration tests, dependency-cruiser checks, or Codex schema drift checks.
- Files: `package.json`, `playwright.mobile.config.ts`, `.dependency-cruiser.cjs`, `scripts/check-codex-schema-drift.mjs`
- Risk: Protocol, dependency-boundary, and browser regressions can ship unless maintainers run the specialized commands.
- Priority: High

**Workspace file APIs need adversarial and large-file tests:**
- What's not tested: Path traversal, symlink edge cases, oversized reads, traversal limits, large untracked diffs, and binary/unicode edge cases need explicit coverage.
- Files: `src/backend/trpc/workspace/files.trpc.ts`, `src/backend/trpc/workspace/files.router.test.ts`, `src/backend/trpc/workspace/git.trpc.ts`, `src/backend/lib/file-helpers.ts`
- Risk: Security and performance regressions in file access can go unnoticed.
- Priority: High

**Periodic task scheduler needs failure-mode coverage:**
- What's not tested: Stale RUNNING executions, workspace-creation failure after schedule advancement, repeated failures, and skipped concurrent runs need focused tests.
- Files: `src/backend/services/periodic-task/service/periodic-task.service.ts`, `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`
- Risk: Recurring automation can silently stop or skip work.
- Priority: High

**Run-script and process lifecycle tests need OS-level edge cases:**
- What's not tested: Grandchild process cleanup, signal handling, cleanup-command failure, output pressure, and environment redaction are not fully covered by ordinary service tests.
- Files: `src/backend/services/run-script/service/run-script.service.ts`, `src/backend/services/run-script/service/startup-script.service.ts`, `src/backend/services/auto-iteration/service/test-runner.service.ts`
- Risk: Long-running scripts can leak processes, expose secrets, or leave stale runtime state.
- Priority: Medium

**ACP permission and schema coverage depends on specialized commands:**
- What's not tested: Real provider behavior and Codex app-server schema compatibility require non-default manual or specialized checks.
- Files: `src/backend/services/session/service/acp/`, `src/backend/services/session/service/acp/codex-app-server-adapter/`, `scripts/check-codex-schema-drift.mjs`, `package.json`
- Risk: Provider upgrades can break permission prompts, session load, or streaming behavior without failing default tests.
- Priority: High

---

*Concerns audit: 2026-05-17*
