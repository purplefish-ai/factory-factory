# Contributing to Factory Factory

Thank you for your interest in contributing to Factory Factory! This document
provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 26.12.0+ (pinned in `.node-version`)
- pnpm
- GitHub CLI (`gh`) - authenticated
- Claude Code - authenticated via `claude login`

### Development Setup

```bash
# Clone the repository
git clone https://github.com/purplefish-ai/factory-factory.git
cd factory-factory

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

## Development Workflow

### Running the App

```bash
# Web app (development)
pnpm dev

# Electron app (development)
pnpm dev:electron

# Production build
pnpm build
pnpm start
```

### Database

The app stores its database at `~/factory-factory/data.db` by default;
`DATABASE_PATH` and `BASE_DIR` override that location. Use `pnpm db:studio` to
inspect it. Follow the Prisma schema row below for migrations and generated
client changes.

## Verification

This is the shared verification policy for contributors and agents. Command
behavior lives in [package scripts](package.json); the
[CI workflow](.github/workflows/ci.yml) defines the enforced CI pipeline.

Prepare schema output as needed below. Before handing changes back, run
`pnpm check:fix`, `pnpm typecheck`, the applicable tests below, then
`pnpm check`. `pnpm check:fix` edits files across the repository, including
Markdown; inspect its diff and keep unrelated changes out of the PR.

| Change             | Additional verification                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application code   | Add focused, co-located Vitest tests for changed behavior, including a regression for bugs. Run `pnpm test` before handoff. While iterating, use `pnpm test path/to/file.test.ts`, `pnpm test -t "name"`, or `pnpm test:watch`. Explain corrections to existing assertions.                         |
| UI                 | Follow the application-code row, update `*.stories.tsx`, and check changed states in Storybook (`pnpm storybook`). Use `pnpm test:e2e:mobile` when mobile behavior changes.                                                                                                                         |
| Prisma schema      | Follow the application-code row. Run `pnpm check:prisma-schema` to regenerate the client, validate ownership and typecheck. Include any required migration (`pnpm db:migrate`) and commit the regenerated `prisma/generated/` output. Generate before checking code that depends on the new schema. |
| Documentation only | Run the shared checks above, validate changed links and anchors, verify documented commands against package scripts, and check `CLAUDE.md` imports when changing agent guides. Application tests are not needed solely for prose changes.                                                           |

Run `pnpm test:integration` for changes to integration behavior. Subsystem notes
may name additional focused checks for their contracts. Inspect the final diff,
report failed or unavailable checks, and never weaken assertions or guardrails
to pass. Repeat successful checks only after edits or new evidence.

`pnpm check` covers linting, formatting, file lengths, environment access,
ownership, foreign-key indexes, dependencies, and Codex schemas. The Codex
schema check skips locally when the pinned CLI is unavailable or mismatched; CI
installs the pinned version. To enforce it locally, use
`CODEX_SCHEMA_CHECK=strict pnpm check:codex-schema` with that CLI installed.
After reducing oversized legacy files, run `pnpm check:file-length:update` to
lower their exact ceilings; it never allows growth.

The [pre-commit hook](.husky/pre-commit) formats staged files and checks types,
migration drift, dependencies, and unused code. CI also runs coverage,
production and Storybook builds, and generated Prisma drift checks. Hooks and CI
supplement the verification above; report any local skips rather than assuming
CI ran.

## Pull Request Process

1. Fork the repository if needed and create a branch from `main`.
2. Make focused changes and follow [verification](#verification).
3. Update documentation when behavior or commands change and inspect the final
   diff.
4. Open the pull request ready for review, with what changed, why, and checks
   run. Cubic does not run on drafts. Use `--body-file` for multiline
   `gh pr create` and `gh issue create` bodies.

### Commit Messages

Write clear, descriptive commit messages:

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Keep the first line under 72 characters
- Reference issues as `(#123)` when relevant

### Code Style

- We use [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) for source
  linting and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) for
  formatting and import sorting. [Biome](https://biomejs.dev/) preserves CSS and
  remaining lint guards; see [lint guardrails](lint-rules/README.md). Markdown
  prose wraps at 80 columns; fenced code is preserved.
- `prisma/generated/` is generated and excluded from linting and formatting;
  follow the schema row in [verification](#verification) when changing it.
- Follow existing patterns in the codebase
- Use TypeScript strict mode
- Prefer Zod for schemas and validation; avoid raw typecasts

## Project Structure

```
src/
├── backend/          # Express + tRPC server
│   ├── services/     # Service capsules and infrastructure services
│   ├── orchestration/  # Cross-service coordination layer
│   ├── trpc/         # tRPC routers
│   └── routers/      # REST/WebSocket route handlers
├── client/           # React frontend
│   ├── components/   # App-level shared components
│   ├── features/     # Feature UI (one folder per feature)
│   └── routes/       # Page routes
├── cli/              # Command-line interface
└── components/       # shadcn/ui design system only

electron/             # Electron main process
prisma/               # Database schema and migrations
```

## Reporting Issues

- Check if the issue already exists
- Use the issue template if available
- Include steps to reproduce the issue
- Include your environment details (OS, Node version, etc.)

## Feature Requests

We welcome feature requests! Please:

- Check existing issues first
- Describe the use case clearly
- Explain why this feature would be useful

## Questions?

Feel free to open a discussion or issue if you have questions about
contributing.

## License

By contributing to Factory Factory, you agree that your contributions will be
licensed under the MIT License.
