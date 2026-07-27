# npm Publish Prisma Guard Design

## Problem

The npm publish workflow fails before tests, packaging, or publishing because
its inline Prisma version check requires `prisma` to appear in both
`dependencies` and `devDependencies`.

Commit `2684a415` removed the redundant `devDependencies.prisma` entry while
retaining `prisma` as an exact runtime dependency. That placement is intentional:
the published package runs Prisma commands during installation and database
migration. The workflow guard was not updated with the package manifest.

## Considered Approaches

1. Restore `devDependencies.prisma`.
   This would satisfy the stale check but duplicate a runtime dependency and
   preserve an unnecessary manifest invariant.
2. Edit the inline workflow expression.
   This is the smallest text change, but leaves a long, untested JavaScript
   program embedded in YAML and makes future drift easy to miss.
3. Extract and test the manifest check.
   This keeps the intended invariant explicit and gives both local and CI users
   the same executable validation. This is the selected approach.

## Design

Add a small Node.js script under `scripts/` that reads a supplied package
manifest and verifies:

- `dependencies["@prisma/adapter-better-sqlite3"]` is an exact version.
- `dependencies["@prisma/client"]` is an exact version.
- `dependencies.prisma` is an exact version.
- All three versions are identical.

The script will not require `devDependencies.prisma`. It will accept an optional
manifest path so tests can execute the real command against temporary fixtures.
Errors will name the missing, ranged, or mismatched dependency and exit
non-zero.

The npm publish workflow will invoke this script instead of embedding the check.
No dependency placement or runtime behavior will change.

## Testing and Validation

Regression tests will execute the real script and cover:

- The current package shape, with Prisma only in `dependencies`, succeeds.
- A missing runtime Prisma dependency fails.
- A ranged Prisma version fails.
- Mismatched exact Prisma versions fail.

Implementation will follow red-green TDD. Final validation will include the
targeted regression test, the full test suite, `pnpm check`, `pnpm typecheck`,
and a local build/package dry run matching the workflow as closely as practical.
