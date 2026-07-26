# Repository Guidelines

## Project Structure & Module Organization
- `src/backend/`: Express + tRPC server, WebSocket handlers, orchestration, and service capsules
- `src/backend/services/`: Service capsules and infrastructure services
- `src/backend/services/{name}/service/`: Business logic for service `{name}`
- `src/backend/services/{name}/resources/`: DB/resource access for service `{name}` (Prisma accessors)
- `src/backend/orchestration/`: Cross-service coordination layer (bridges, workspace init/archive, child workspace coordination)
- `src/client/`: React UI (routes/pages, plus client-specific hooks/components/lib; router in `src/client/router.tsx`)
- `src/cli/`: CLI entrypoint and commands
- `src/components/`: Shared UI components (shadcn/ui)
- `electron/`: Electron main process wrapper
- `prisma/`: Prisma schema and migrations
- `prompts/`: Prompt templates copied into `dist/` on build

Path aliases: `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`.

## Build, Test, and Development Commands
- `pnpm dev`: Start backend + frontend with hot reload
- `pnpm build`: TypeScript backend build + Vite frontend build
- `pnpm start`: Run production server
- `pnpm dev:electron`: Electron app with hot reload
- `pnpm test`: Run Vitest test suite
- `pnpm check`: Run standard guardrails (Biome, env, ownership, dependency boundaries, Codex schema)
- `pnpm typecheck`: TypeScript checks only
- `pnpm check:fix`: Lint + format with Biome
- `pnpm db:migrate`, `pnpm db:generate`, `pnpm db:studio`: Prisma workflows

## Coding Style & Naming Conventions
- TypeScript project with strict type checking.
- Formatting and linting are enforced by Biome (`pnpm check:fix`).
- Prefer existing patterns and directory conventions; keep backend logic in `src/backend/` and UI in `src/client/`.

## Backend Service Capsule Pattern
- **Service capsules:** session, workspace, github, linear, ratchet, terminal, run-script, settings, decision-log, periodic-task (under `src/backend/services/{name}/`)
- Each capsule has an `index.ts` barrel file as the sole public API
- Consumers must import from barrel (`@/backend/services/session`), never from internal paths
- Service-to-service imports must go through barrel imports and follow `dependsOn` in `src/backend/services/registry.ts`
- Prisma model ownership is declared in `src/backend/services/registry.ts` and validated by `scripts/check-service-registry.ts`
- `src/backend/orchestration/` coordinates cross-service workflows
- Root files in `src/backend/services/*.ts` remain infrastructure/cross-cutting services (logger, config, scheduler, etc.)
- Tests are co-located with each service module

## Inngest Functions & Steps
- When defining Inngest functions or steps, identify any inputs or outputs that could grow large (e.g., file contents, diffs, logs, embeddings, serialized data).
- Pass large payloads via S3 links (store to S3 first, pass the URL) rather than inlining them as raw values in event data or step return values.
- This prevents hitting Inngest's event/step payload size limits and keeps execution state lean.

## Testing Guidelines
- Tests are run with Vitest (`pnpm test`, `pnpm test:watch`, `pnpm test:coverage`).
- Add tests alongside the modules they cover or in existing test locations for the package you touch.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and descriptive (e.g., “Fix session tab close requiring double-click”), often with issue/PR references like `(#123)`.
- Keep the first line under 72 characters and reference issues when relevant.
- PRs should include: a clear description, any required tests run (`pnpm test`, `pnpm typecheck`, `pnpm check`, `pnpm check:fix`), and updated docs when behavior changes.

## Git & GitHub CLI
- Authenticate once: `gh auth login`, verify with `gh auth status`.
- Create a feature branch: `git switch -c your-branch-name`.
- Keep work tidy: `git status`, `git diff`, `git add -p`, `git commit -m "Verb phrase"`.
- Open a PR: `gh pr create --fill` (edit title/body as needed), then push updates with `git push`.
- For multi-line PR bodies, prefer `--body-file` to avoid newline escaping issues (write content to a temp file and pass it to `gh pr create`).
- For multi-line issue bodies, prefer `gh issue create --body-file` or `gh issue edit --body-file` to preserve newlines.

## Contributor Checklist
- Add or update tests and run `pnpm test` (use `pnpm test:watch` during development).
- Add or update Storybook stories when UI changes are introduced (`pnpm storybook`).
- Run `pnpm check`, `pnpm typecheck`, and `pnpm check:fix`.
- Run `pnpm check:prisma-schema` when `prisma/schema.prisma` changes.
- `pnpm check` enforces Codex schema drift in CI. Locally, that check is skipped unless the pinned Codex CLI is installed; use `CODEX_SCHEMA_CHECK=strict pnpm check:codex-schema` to enforce it.
- Ensure schemas use Zod and avoid raw typecasts.
- Update docs if behavior or commands change.

## Security & Configuration Notes
- Default database path is `~/factory-factory/data.db`, overridden by `DATABASE_PATH` or `BASE_DIR`.
- The app can run commands without manual approval in some modes; review changes carefully before merging.

## Feature Notes (Keep Docs Current)
- **Auto-Fix (Ratchet):** Automatically watches pull requests and dispatches agents to fix issues (1-minute check cadence). When a PR has failing CI or actionable review feedback, creates a fixer session to address it. The global review-trigger mode defaults to `CHANGES_REQUESTED`, which includes changes-requested review bodies and unresolved inline review threads; `ALL_REVIEW_FEEDBACK` additionally permits top-level commented review summaries. Ordinary PR conversation comments never trigger Ratchet or advance its review snapshot. PR states: `IDLE` / `CI_RUNNING` / `CI_FAILED` / `REVIEW_PENDING` / `READY` / `MERGED`. Workspace-level toggle controls whether auto-fix is active. Admin settings control the default ratchet state for new workspaces and the global review-trigger mode. The ratchet's mutable state lives in a 1:1 `WorkspaceRatchet` row (`enabled`, `lastCheckedAt`, `activeSessionId`, `dispatchSnapshotKey`, `dispatchOutcome`, `dispatchRetryCount`), written only by `workspace-ratchet.accessor.ts`; reads flatten it back onto the workspace under the old `ratchet*` names. `ratchetState` is **not** stored: it is projected by `deriveRatchetState` (`src/shared/core/ratchet-state.ts`) from `ratchetEnabled` plus `WorkspacePR.state`/`ciStatus`/`reviewState`/`hasMergeConflict`, computed at the same accessor boundary that flattens the side tables. The 127-line transition table it used to be validated against permitted all 49 of its 49 state pairs and is gone, as are the compare-and-swap on `state` and the two settling writes (disable, `markPrClosed`) that forced it to `IDLE` — a disabled workspace and a closed PR both derive to `IDLE`. `WorkspacePR.hasMergeConflict` was added to hold the one input that was previously observed on every fetch but only ever stored as the derived `MERGE_CONFLICT` value. Because the projection reads the cache, a ratchet check now persists its whole observation (`prState`, `prReviewState`, `prCiStatus`, `hasMergeConflict`) via `recordPrObservation` rather than CI alone — otherwise a merge or a new changes-requested review would not be visible until the separate PR-sync poller caught up. Each fixer dispatch is tracked via an explicit record on that row (snapshot key + outcome `RUNNING`/`COMPLETED`/`DIED` + retry count): deliberate stops and clean exits settle as `COMPLETED` (no re-dispatch while the PR state is unchanged), unexpected exits settle as `DIED` and are re-dispatched for the same PR state up to 3 times. Review comments belonging to resolved review threads (GraphQL `reviewThreads.isResolved`) are excluded from fixer dispatch prompts and from the "has actionable review comments" trigger; they still count toward the review-activity timestamp so dispatch snapshot keys stay stable when threads get resolved. Dispatch state is persisted as soon as prompt execution begins, without waiting for the full ACP turn to complete; a later prompt failure conditionally settles the matching dispatch as `DIED`.
- **PR cache:** Everything cached from GitHub about a workspace's PR lives in a 1:1 `WorkspacePR` row (`url`, `number`, `state`, `reviewState`, `ciStatus`, `hasMergeConflict`, `syncedAt`, `discovery*` scheduling, `ciFailedAt`, `ciLastNotifiedAt`, `reviewLast*` cursors), written only by `workspace-pr.accessor.ts`; reads flatten it back onto the workspace under the old `pr*` names, so the snapshot wire, the v4 export format and the client are unchanged. A row exists for every workspace, including those with no PR, because discovery claims its backoff before a PR exists. `syncedAt` was `prUpdatedAt` on `Workspace`, a name that read as GitHub's PR `updated_at` but always held the caller's observation time. Claiming a discovery attempt no longer bumps `Workspace.updatedAt`, so polling no longer registers as workspace activity.
- **Run script:** The workspace's dev server lives in a 1:1 `WorkspaceRunScript` row (`command`, `postRunCommand`, `cleanupCommand`, `pid`, `port`, `startedAt`, `status`), written only by `workspace-run-script.accessor.ts`; reads flatten it back onto the workspace under the old `runScript*` names, so the snapshot wire, the v4 export format and the client are unchanged. Two concerns share the row: the three commands are a cache of the worktree's `factory-factory.json`, the four runtime columns describe a live process. They share it because they share a writer. The config group is *not* derived on read the way the kanban column and `RatchetState` are — its source of truth is a file, so deriving it would cost a filesystem call per workspace per list query; `reconcileWorkspaceCommandCache` repairs drift before a script starts or stops instead. The runtime group is persisted despite a restart invalidating the process, because `pid` is the only handle on an orphaned run script (`verifyRunning` uses `process.kill(pid, 0)`); only `STARTING`/`STOPPING` are cleared at startup. `registerInitializedWorktree` writes the worktree columns and the commands in one transaction, since they were one statement before the split.
- **GitHub integration:** Uses local `gh` auth; issue fetch supports workspace issue picker (`listIssuesForWorkspace`) and Kanban intake (`listIssuesForProject`, assigned to `@me`). Starting from an issue creates a linked workspace (`githubIssueNumber`, `githubIssueUrl`).
- **Linear integration:** Per-project issue provider can be set to Linear with encrypted API key + team selection. Kanban intake uses Linear issues assigned to the configured viewer. Starting from an issue creates a linked workspace (`linearIssueId`, `linearIssueIdentifier`, `linearIssueUrl`) and workspace lifecycle events best-effort sync issue state in Linear.
- **Kanban model:** UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`) plus the columns `WORKING`, `WAITING`, `DONE`. The column is derived from workspace state on every read and never persisted, so every surface (kanban board, sidebar, snapshot stream) shows the same answer; READY workspaces with no prior sessions are intentionally hidden, and archived workspaces derive no column at all so they stay off the board. One endpoint (`workspace.listForProject`) serves both the board and the sidebar, and one React Query cache backs both — the snapshot WebSocket patches that single cache.
- **Quick actions:** Workspace quick actions are markdown-driven from `prompts/quick-actions/` (frontmatter metadata + prompt body). Agent quick actions create follow-up sessions and auto-send prompt content when session is ready.
- **Periodic Tasks:** Scheduled recurring tasks that create a fresh workspace on a configured cadence (daily, weekly, monthly, or testing cadences every minute/five minutes). Daily/weekly/monthly tasks can optionally be configured to run at a specific time of day in the user's browser timezone (`scheduledTime` HH:MM + IANA `timezone` fields). Each execution runs the configured prompt, monitors for PR creation, and advances the schedule. Concurrent runs are skipped. Managed via the "Periodic Tasks" admin tab and created from the Kanban launch dropdown. Workspace right panel shows execution history for periodic-task-sourced workspaces. Service capsule: `src/backend/services/periodic-task/`.
- **Child Workspaces:** A parent workspace can spawn child workspaces (in any project) via MCP tools exposed to the agent (`spawn_child_workspace`, `send_message_to_child`, `archive_child_workspace`, `list_projects`). Children report back via `send_message_to_parent`. Messages are persisted first as `WorkspaceNotification` rows, then delivered live to active sessions when available; undelivered rows are delivered at the next session start. Max depth is 1 (children cannot have children). UI: ChildWorkspacesPanel in right panel, child badge on kanban cards, archive warning when parent has active children. Orchestration: `src/backend/orchestration/workspace-children.orchestrator.ts`. MCP server: `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`.
- **ACP Runtime:** All agent sessions use the Agent Client Protocol (ACP) via `@agentclientprotocol/sdk`. CLAUDE sessions spawn `claude-agent-acp`; CODEX sessions spawn Factory Factory's internal `codex-app-server-acp` adapter, both over stdio JSON-RPC. Session init/load is fail-fast and requires provider `configOptions` with model/mode categories. Permission requests present multi-option selection (`allow_once`, `allow_always`, `deny_once`, `deny_always`) and are bridged through ACP permission response handlers.
