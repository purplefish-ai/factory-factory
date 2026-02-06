# Repository Guidelines

## Project Structure & Module Organization
- `src/backend/`: Express + tRPC server, WebSocket handlers, and resource accessors
- `src/client/`: React UI (routes in `src/client/routes/`, router in `src/client/router.tsx`)
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
- **Ratchet:** Central PR progression loop (1-minute cadence) that checks READY workspaces with PRs and moves through `CI_RUNNING` / `CI_FAILED` / `REVIEW_PENDING` / `READY` / `MERGED`. Merge conflicts are resolved opportunistically by agents syncing with main before CI/review fixes. Fixer sessions use workflow `ratchet` and respect Admin ratchet toggles + allowed reviewers.
- **GitHub integration:** Uses local `gh` auth; issue fetch supports workspace issue picker (`listIssuesForWorkspace`) and Kanban intake column (`listIssuesForProject`, assigned to `@me`). Starting from an issue should create a linked workspace (`githubIssueNumber`, `githubIssueUrl`).
- **Kanban model:** UI has `ISSUES` + DB columns `WORKING`, `WAITING`, `DONE`. Column state is derived, not manually set; READY workspaces with no prior sessions are intentionally hidden, and archived workspaces preserve cached pre-archive column.
- **Quick actions:** Workspace quick actions are markdown-driven from `prompts/quick-actions/` (frontmatter metadata + prompt body). Agent quick actions create follow-up sessions and auto-send prompt content when session is ready.
