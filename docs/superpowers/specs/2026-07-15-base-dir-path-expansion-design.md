# BASE_DIR-Dependent Path Expansion Design

## Goal

Ensure configured paths that reference `BASE_DIR` use its already-expanded value, so values such as `BASE_DIR=/Users/$USER/factory-factory` and `WORKTREE_BASE_DIR=$BASE_DIR/worktrees` resolve without literal environment-variable tokens.

## Root Cause

`expandEnvVars` intentionally performs one substitution pass. `loadSystemConfig` expands `BASE_DIR` first, but later path settings call `expandEnvVars` with the raw process environment. Those calls substitute `$BASE_DIR` with the original value, which can still contain `$USER`. The same ordering issue exists in the shared and CLI database-path resolvers.

## Design

Preserve the single-pass contract of `expandEnvVars`. After resolving `BASE_DIR`, create a non-mutating environment overlay whose `BASE_DIR` entry is the resolved value. Use that overlay when expanding dependent path settings:

- `WORKTREE_BASE_DIR`
- `REPOS_DIR`
- `DATABASE_PATH`
- `MIGRATIONS_PATH`
- the shared `getDatabasePath()` helper
- the CLI `resolveDatabasePath()` helper

Explicit CLI `databasePath` options remain literal user-supplied paths and keep their current precedence. Unrelated path settings that currently do not support environment expansion remain unchanged.

## Alternatives Considered

1. Make `expandEnvVars` recursive. Rejected because existing tests deliberately require one-pass expansion, and recursion reintroduces circular-reference and parsing risks.
2. Build a general dependency graph for all environment variables. Rejected as unnecessary complexity for the documented `BASE_DIR` dependency.
3. Pass an environment overlay containing resolved `BASE_DIR` to dependent expansions. Selected because it is local, preserves current helper semantics, and directly models the configuration dependency.

## Error Handling and Compatibility

No new exceptions or validation are introduced. Unknown variables remain literal, matching the current helper contract. `$BASE_DIR` and `${BASE_DIR}` continue to work through the existing parser. The overlay is a new object and never mutates `process.env` or a caller-provided environment.

## Testing

- Add a config-service regression test that uses nested `USER` → `BASE_DIR` → configured-path references and asserts worktree, repository, database, and migration paths are fully expanded.
- Add a shared `getDatabasePath()` regression test for `DATABASE_PATH=$BASE_DIR/data.db` with a nested `BASE_DIR`.
- Add a CLI resolver regression test using a caller-provided environment with the same nested dependency.
- Retain the existing test asserting that `expandEnvVars` itself is not recursive.

## Scope

No UI behavior changes, screenshots, database migrations, or WebSocket-handler edits are required. Correcting configuration at its source prevents the existing working-directory validation from receiving a path containing literal `$` tokens.
