# Contributing to Factory Factory

Thank you for your interest in contributing to Factory Factory! This document
provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 26.12.1+ (pinned in `.node-version`)
- pnpm
- GitHub CLI (`gh`) - authenticated
- Claude authentication via `pnpm exec tsx src/cli/index.ts claude auth login`
  (the runtime is included; a global Claude installation is not required)

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

Worktrees on different branches often share that database, so one branch can
apply migrations another branch does not have. Production launches refuse such a
database by default (the `ff` commands continue with a warning when
`FF_ALLOW_UNKNOWN_MIGRATIONS=1` is set); `pnpm dev` (`ff serve --dev`) prints a
warning naming the unknown migrations and starts anyway. Use a separate
`DATABASE_PATH` when branch schemas diverge in ways the other branch's code
cannot tolerate.

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
| UI                 | Follow the application-code row, update `*.stories.tsx` following the [Storybook conventions](docs/storybook.md), check changed states in Storybook (`pnpm storybook`), and run `pnpm test:storybook`. Use `pnpm test:e2e:mobile` when mobile behavior changes.                                     |
| Prisma schema      | Follow the application-code row. Run `pnpm check:prisma-schema` to regenerate the client, validate ownership and typecheck. Include any required migration (`pnpm db:migrate`) and commit the regenerated `prisma/generated/` output. Generate before checking code that depends on the new schema. |
| Documentation only | Run the shared checks above, validate changed links and anchors, verify documented commands against package scripts, and check `CLAUDE.md` imports when changing agent guides. Application tests are not needed solely for prose changes.                                                           |

Draft persistence also has a browser storage suite:
`pnpm exec playwright test --config=playwright.drafts.config.ts`. It uses the
installed Playwright Chromium and a frontend-only Vite server; the regular
Vitest suite does not require a browser installation.

Run `pnpm test:integration` for changes to integration behavior. Subsystem notes
may name additional focused checks for their contracts. Inspect the final diff,
report failed or unavailable checks, and never weaken assertions or guardrails
to pass. Repeat successful checks only after edits or new evidence.

Vitest keeps application, UI, native and integration tests isolated. Tests under
`src/client` and `src/components` use `vmForks`: each file gets a fresh VM
context, module graph, and (jsdom suites) window while workers reuse dependency
imports. This includes frontend utility tests running in the Node environment.
Workers recycle after reaching 512 MB. Backend, native and process suites retain
fork isolation. The explicit `frontendForkTests` exceptions in
`vitest.config.ts` preserve whole-window replacements, native HTTP/cache
reference identity, strict cross-realm equality behavior, and Mermaid's ESM
dependency loading. New frontend tests with incompatible globals, identity
behavior, or ESM loading should join that exception list, preserving their
existing assertions. The `shared` project reuses thread workers for the audited
`reusableSharedTests` allowlist in `vitest.config.ts` to avoid repeated imports.
Those tests must clean up their resources and avoid module mocks or shared
global mutations. New files stay isolated by default; remove a file from the
allowlist if it needs isolation. `pnpm test:integration` still selects only
backend integration tests.

Integration database tests copy a closed, fully migrated SQLite template made
once per Vitest project by `integration-db.global-setup.ts`. Each helper call
still gets its own writable database, Prisma client, environment binding, and
module reset. Project teardown removes the template; migration-specific tests
continue to run migrations directly. Standalone Vitest configs without this
global setup fall back to migrating each private database. Watch mode reruns
when migration files change and rebuilds the template from current SQL before
dispatching tests, including edits to already applied migrations. Unchanged
migrations keep the existing template; failed rebuilds abort the rerun without
publishing a partial replacement. A failed private database creation restores
the previously active client and environment binding.

Event runtime fixtures await bounded provider-creation notifications instead of
polling. Create a fresh `eventProviderCollection()` in each test fixture, add
providers through its `add` method, and await `waitForProviders(count)` to
retain exact-count assertions and a bounded failure when startup stalls. Fixture
teardown tracks real background PR wakes through completion and drains newly
spawned work before disconnecting the private database; the generic retry
fixture also shuts down session queue retries, as application shutdown does.
Work that outlives a test file and logs can fail CI with
`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`;
stop or drain its owner in teardown rather than muting the log.

`pnpm check` covers linting, formatting, file lengths, environment access,
ownership, foreign-key indexes, and dependencies. Upstream ACP adapters own
their provider protocol schemas; test ACP client contracts when upgrading either
adapter. After reducing oversized legacy files, run
`pnpm check:file-length:update` to lower their exact ceilings; it never allows
growth. The file-length check also prints a non-failing warning listing files
that are within the 1,000-line cap but at or above 98% of it, whether or not
they have a stale baseline entry; files over the cap are reported only as
violations. Before growing one, split it by responsibility; do not compress it
by dropping blank lines or comments.

CI caches the Node native-module binaries by operating system, Ubuntu release,
architecture, Node ABI, dependency lockfile and native-module setup script. It
restores only the binary cache directory, so the setup script still copies those
binaries into the fresh installation before tests; the active-runtime marker is
never restored from CI cache.

The [pre-commit hook](.husky/pre-commit) formats staged files and checks types,
migration drift, dependencies, and unused code. CI also runs coverage,
production and Storybook builds, story tests, and generated Prisma drift checks.
Hooks and CI supplement the verification above; report any local skips rather
than assuming CI ran.

CI runs the full Vitest suite across exactly two parallel shards. The sequencer
balances files using measured test, import, setup and environment durations from
the last successful run. Both shards restore the same immutable history
snapshot; a cold or malformed cache uses deterministic equal estimates, and new
files use their project's median duration. History only affects assignment,
never test selection or isolation. Each shard uploads its discovered/assigned
file lists, measurements and coverage blob without checking partial coverage
against whole-suite thresholds.

The coverage gate requires both shards to pass, verifies every discovered test
was assigned and reported exactly once, then merges their reports and enforces
the normal thresholds and critical surface checks. Missing reports fail the
gate. It installs only the pinned Vitest coverage toolchain in
`.github/coverage-merge/`, avoiding restoration of the application's dependency
cache. Global thresholds live in the shared `vitest.coverage.ts`; a regression
test keeps both toolchains' Vitest and coverage versions in sync. Update both
manifests and lockfiles when upgrading those packages. Successful coverage runs
publish the next duration cache. Local `pnpm test:coverage` still runs and
checks the complete suite in one process.

CI selects work from the integrated PR diff. Documentation-only changes in the
explicit prose allowlist omit application builds/tests and Storybook; backend
TypeScript-only changes also omit Storybook. Lint/type/dependency checks always
run. Shared code, dependencies, styles, configuration and unknown paths trigger
all work. Main and merge-queue runs always run everything. The existing required
`Build`, `Storybook Build`, `Storybook Tests` and `Test` checks remain present:
their gates require either successful selected work or an explicit irrelevant
change decision. Failed selection, missing outputs, unexpected skips and failed
workers fail the gates.

New pushes to each PR cancel older revisions of that PR in CI and CodeQL; new
pushes to `main` cancel older main-push runs. Cancellation groups include the
workflow and PR number, while merge-queue and scheduled runs stay independent.
npm publishing and Electron release workflows are excluded from this
cancellation policy.

Docker images support the optional [Compose deployment](docker-compose.yml). The
Docker Build and Docker Build & Push workflows run only through GitHub Actions'
**Run workflow** control. Use Docker Build to validate an image without
publishing, or Docker Build & Push on `main` to publish main and commit tags to
GHCR. Publishing is skipped when another ref is selected. Docker builds are not
part of pull request, merge-queue, or main-push checks.

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
- Reference issues as `(#123)` when relevant; use a closing keyword such as
  `Fix #123` when the change resolves the issue

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
