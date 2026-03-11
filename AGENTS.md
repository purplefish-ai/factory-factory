# Repository Guidelines

## Project Structure & Module Organization
- `src/backend/`: Express + tRPC server, WebSocket handlers, orchestration, and service capsules
- `src/backend/services/`: Service capsules and infrastructure services
- `src/backend/services/{name}/service/`: Business logic for service `{name}`
- `src/backend/services/{name}/resources/`: DB/resource access for service `{name}` (Prisma accessors)
- `src/backend/orchestration/`: Cross-service coordination layer (bridges, workspace init/archive)
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
- `pnpm typecheck`: TypeScript checks only
- `pnpm check:fix`: Lint + format with Biome
- `pnpm db:migrate`, `pnpm db:generate`, `pnpm db:studio`: Prisma workflows

## Coding Style & Naming Conventions
- TypeScript project with strict type checking.
- Formatting and linting are enforced by Biome (`pnpm check:fix`).
- Prefer existing patterns and directory conventions; keep backend logic in `src/backend/` and UI in `src/client/`.

## Backend Service Capsule Pattern
- **Service capsules:** session, workspace, github, linear, ratchet, terminal, run-script, settings, decision-log (under `src/backend/services/{name}/`)
- Each capsule has an `index.ts` barrel file as the sole public API
- Consumers must import from barrel (`@/backend/services/session`), never from internal paths
- Service-to-service imports must go through barrel imports and follow `dependsOn` in `src/backend/services/registry.ts`
- Prisma model ownership is declared in `src/backend/services/registry.ts` and validated by `scripts/check-service-registry.ts`
- `src/backend/orchestration/` coordinates cross-service workflows
- Root files in `src/backend/services/*.ts` remain infrastructure/cross-cutting services (logger, config, scheduler, etc.)
- Tests are co-located with each service module

## Testing Guidelines
- Tests are run with Vitest (`pnpm test`, `pnpm test:watch`, `pnpm test:coverage`).
- Add tests alongside the modules they cover or in existing test locations for the package you touch.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and descriptive (e.g., “Fix session tab close requiring double-click”), often with issue/PR references like `(#123)`.
- Keep the first line under 72 characters and reference issues when relevant.
- PRs should include: a clear description, any required tests run (`pnpm test`, `pnpm typecheck`, `pnpm check:fix`), and updated docs when behavior changes.

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
- Run `pnpm typecheck` and `pnpm check:fix`.
- Ensure schemas use Zod and avoid raw typecasts.
- Update docs if behavior or commands change.

## Security & Configuration Notes
- Default database path is `~/factory-factory/data.db`, overridden by `DATABASE_PATH` or `BASE_DIR`.
- The app can run commands without manual approval in some modes; review changes carefully before merging.

## Feature Notes (Keep Docs Current)
- **Auto-Fix (Ratchet):** Automatically watches pull requests and dispatches agents to fix issues (1-minute check cadence). When a PR has failing CI or review comments, creates a fixer session to address them. PR states: `IDLE` / `CI_RUNNING` / `CI_FAILED` / `REVIEW_PENDING` / `READY` / `MERGED`. Workspace-level toggle controls whether auto-fix is active. Admin setting controls the default ratchet state for new workspaces.
- **GitHub integration:** Uses local `gh` auth; issue fetch supports workspace issue picker (`listIssuesForWorkspace`) and Kanban intake (`listIssuesForProject`, assigned to `@me`). Starting from an issue creates a linked workspace (`githubIssueNumber`, `githubIssueUrl`).
- **Linear integration:** Per-project issue provider can be set to Linear with encrypted API key + team selection. Kanban intake uses Linear issues assigned to the configured viewer. Starting from an issue creates a linked workspace (`linearIssueId`, `linearIssueIdentifier`, `linearIssueUrl`) and workspace lifecycle events best-effort sync issue state in Linear.
- **Kanban model:** UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`) plus DB columns `WORKING`, `WAITING`, `DONE`. Column state is derived, not manually set; READY workspaces with no prior sessions are intentionally hidden, and archived workspaces preserve cached pre-archive column.
- **Quick actions:** Workspace quick actions are markdown-driven from `prompts/quick-actions/` (frontmatter metadata + prompt body). Agent quick actions create follow-up sessions and auto-send prompt content when session is ready.
- **ACP Runtime:** All agent sessions use the Agent Client Protocol (ACP) via `@agentclientprotocol/sdk`. CLAUDE sessions spawn `claude-agent-acp`; CODEX sessions spawn Factory Factory's internal `codex-app-server-acp` adapter, both over stdio JSON-RPC. Session init/load is fail-fast and requires provider `configOptions` with model/mode categories. Permission requests present multi-option selection (`allow_once`, `allow_always`, `deny_once`, `deny_always`) and are bridged through ACP permission response handlers.
