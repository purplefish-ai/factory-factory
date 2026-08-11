# File-Length Ratchet Design

## Goal

Introduce a 1,000-line limit for handwritten JavaScript and TypeScript files without requiring all existing oversized files to be split in one change. Existing debt is represented by an exact, one-way baseline: an oversized file may shrink, but it may never grow.

## Scope

The checker examines candidate files under `src/`, `electron/`, and `scripts/`. Candidates include tracked files and unignored, untracked files so a new oversized file is caught before it is staged. Supported extensions are `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.mts`, `.cjs`, and `.cts`.

Production code, tests, stories, and fixtures all use the same 1,000-line limit. Generated Prisma code, dependencies, build output, assets, documentation, lockfiles, and unsupported file types are outside the checker scope.

Physical lines are counted consistently across LF and CRLF files. Comments and blank lines count. A final newline terminates the final line but does not create an extra phantom line. A file with exactly 1,000 lines passes.

## Architecture

`scripts/check-file-length.ts` contains a small testable core and a thin command-line entry point. The core receives explicit candidate paths, file contents, and baseline data; repository discovery is kept at the command-line boundary. Repository discovery uses Git's cached and unignored-untracked file listing rather than recursively scanning the working tree.

`scripts/file-length-baseline.json` stores an alphabetically sorted object mapping each existing oversized repository-relative path to its exact physical line count. It contains only files above 1,000 lines.

The package exposes two commands:

- `pnpm check:file-length` evaluates the working tree without writing.
- `pnpm check:file-length:update` synchronizes only legitimate downward progress.

The normal checker is added near the beginning of `pnpm check` so it fails quickly.

## Validation Rules

The normal check fails when:

- a file absent from the baseline exceeds 1,000 lines;
- a baseline file exceeds its recorded count;
- a baseline file shrinks but its recorded count has not been lowered;
- a baseline file reaches 1,000 lines but its entry has not been removed; or
- a baseline path no longer exists, including after a rename.

Requiring the baseline to equal the current count for every remaining oversized file makes every reduction visible in review. Diagnostics include the repository-relative path, current count, allowed or recorded count, and the corrective action.

Diagnostics and serialized baseline entries are sorted by path for deterministic output.

## Downward-Only Update

The update command may:

- lower the recorded count for an existing oversized file; and
- remove an entry whose file is deleted or has reached 1,000 lines.

It refuses to write when:

- an existing baseline file grew; or
- a file not already represented in the baseline exceeds 1,000 lines.

This prevents the update command from becoming a way to bless new debt. The initial baseline is committed as part of introducing the checker; subsequent updates can only reduce it.

The baseline is written atomically only after the complete working tree has been validated for forbidden growth and new oversized files. A failed update leaves the baseline unchanged.

## Testing

`scripts/check-file-length.test.ts` tests observable policy using real files in temporary directories. The filesystem is not mocked, and tests do not depend on the repository's current oversized files. Pure function tests cover most behavior; one command-line-level test verifies exit status and human-readable diagnostics.

The test suite covers:

- 1,000 lines passing and 1,001 lines failing;
- equivalent LF and CRLF counting, including final-newline behavior;
- an exact baseline count passing;
- growth failing;
- shrinkage requiring a lower baseline;
- reaching 1,000 lines requiring baseline removal;
- downward updates lowering and removing entries;
- updates refusing growth and newly oversized files without modifying the baseline;
- supported path and extension filtering;
- generated and unsupported files being excluded;
- missing and renamed baseline paths being detected; and
- deterministic diagnostic and baseline ordering.

Vitest's include configuration is extended to run `scripts/**/*.test.ts`, so these tests run under the repository's standard `pnpm test` command.

## Migration to Native Biome Enforcement

Once the baseline is empty, remove the custom baseline/update behavior and enable Biome's pinned `lint/nursery/noExcessiveLinesPerFile` rule with `maxLines: 1000`. The established generated-code override remains in place. The custom checker may then be removed because Biome can enforce the steady-state policy directly.
