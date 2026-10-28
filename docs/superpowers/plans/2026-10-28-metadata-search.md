# Metadata Search Implementation Plan

**Goal:** Find projects, workspaces, and named conversations from one minimal
global search dialog. This implements the metadata-first scope approved in the
conversation; full transcript and repository search remain future work.

**Architecture:** A read-only search capsule queries existing SQLite metadata,
ranks matches before limiting results, and exposes a tRPC query. The header
opens a responsive cmdk dialog. Conversation links select their session through
a URL parameter. No migration, background indexing, or new dependency is needed.

**Tech stack:** Existing TypeScript, Prisma/SQLite, tRPC, React, Radix, and
cmdk.

## Constraints and review focus

- Use Node 26.12.1 and pnpm 12.15.0 in the existing isolated worktree.
- Match names, descriptions, branches, issue references, and attached PR titles.
- Empty input shows recent items; archived projects/workspaces are opt-in.
- Treat search input literally, including punctuation and SQL metacharacters.
- Rank exact titles before prefixes, substrings, and supporting metadata.
- Debounce requests and never allow obsolete results to navigate on Enter.
- Preserve keyboard selection, Escape, focus restoration, and mobile usability.
- Session links must work within the current workspace and across workspaces.
- Do not merge automatically or post PR comment replies.

## Task 1: Metadata query

Files: `src/shared/search.ts`,
`src/backend/services/search/{index.ts,resources/metadata-search.accessor.ts,service/metadata-search.service.ts}`,
`src/backend/services/search/service/metadata-search.service.test.ts`,
`src/backend/trpc/search.trpc.ts`, registry and application composition.

- [x] Write real SQLite tests for ranking, all metadata fields, literal input,
      archive exclusion, named sessions, recency, and bounded results.
- [x] Run the tests and observe the missing implementation failure.
- [x] Implement the read-only query and validated tRPC boundary.
- [x] Run the tests and typecheck.

## Task 2: Search dialog and navigation

Files: `src/client/features/search/`, `src/client/components/app-header.tsx`,
`src/client/routes/projects/workspaces/use-workspace-detail-hooks.ts`, and
co-located tests/stories.

- [x] Write interaction tests for opening, keyboard navigation, stale results,
      errors/retry, and direct conversation selection.
- [x] Observe failures, then implement the compact global dialog and links.
- [x] Add recent, results, empty, error, and loading Storybook states.
- [x] Verify focused tests and inspect desktop/mobile stories in the browser.

## Task 3: Delivery checks

- [x] Document search scope and keyboard shortcut in the current docs.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, `pnpm check`, and the
      applicable UI build/mobile checks.
- [x] Review the final diff and address actionable findings.

## Execution notes

The user explicitly authorized implementation of the scoped recommendation.
Proceed inline; no additional design approval is needed. Metadata remains in its
current tables. Transcript indexing remains a later release.

Review fixes cover Unicode names, same-workspace conversation selection, and
chat navigation taking precedence over a restored file tab. Forty focused tests
and the three mobile layout checks pass; production build and typecheck pass.

Final verification: 8,433 tests pass (three skipped), `pnpm check` passes, and
the relocated database search test passes all 15 cases. Visual checks cover
desktop/mobile, light/dark, results, loading, empty, failure, and archived
states.

PR review follow-up adds database-bounded Unicode filtering, matched metadata
snippets, kind-specific result identities, canonical highlighting, reliable
keyboard controls, and archive dialog lifecycle fixes. The restored-file-tab
tests cover both mount-time navigation and a link arriving after restoration.
