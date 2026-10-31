# Task 1: Project creation draft persistence

Implemented versioned per-project IndexedDB storage, synchronous module-cache
read-your-writes, ordered saves and transactional revision-checked clears. Both
opening and transactions have a 1.5 second bound. Failed persistence keeps the
latest in-memory input usable and reports an inline warning. Corrupt records
reject restoration as a whole, including attachments, instead of silently
restoring partial input.

The external-store hook restores across remounts, captures submission identity,
and binds asynchronous edits to their original project. The form persists
instructions, attachment contents, launch snapshots, ratchet selection, periodic
mode/cadence/time. Cancel and Escape preserve input; explicit Discard clears it.
Submission is disabled during hydration. Restored textareas resize. Desktop and
mobile boards offer Resume draft while keeping explicitly closed composers
closed.

Session selection publishes an intentional serializable snapshot API through its
feature barrel, including provider drafts and saved defaults. Restored choices
survive delayed settings and project switches, including explicit null
reasoning. Existing provider-click behavior (select saved default model) stays
covered by the original tests.

## Task 2 integration interfaces

- `useWorkspaceCreationDraft(projectId)` returns `draft`, `hasDraft`,
  `isRestoring`, `persistenceError`, `updateDraft(patchOrUpdater)`,
  `captureDraft()`, and `clearSubmittedDraft(revision)`.
- `captureDraft()` synchronously returns `{ projectId, revision }`. Capture at
  submit time, before invoking the mutation. A new edit receives a fresh UUID
  revision. The project is captured by each hook callback.
- `clearSubmittedDraft(revision)` returns `Promise<boolean>` and binds to the
  hook's project. An expected revision mismatch leaves newer input intact.
- Storage exposes `loadWorkspaceCreationDraft(projectId)`,
  `saveWorkspaceCreationDraft(projectId, draft)`, and
  `clearWorkspaceCreationDraft(projectId, expectedRevision)`. Clears compare
  revisions in one readwrite transaction. Cleared revisions are tombstoned in
  memory to reject late old saves.
- `getWorkspaceCreationDraftSnapshot(projectId)` synchronously returns the
  authoritative `{ draft, isRestoring, persistenceError }` cache snapshot.
  `subscribeWorkspaceCreationDraft(projectId, listener)` supports remount-safe
  external consumers. An untouched composer can have `draft: null` in storage;
  its hook still supplies an empty draft and captured project/revision.
- `useInlineWorkspaceDraft` is the form-specific binding for all field setters
  and the session-selection snapshot. Task 2 can use its inherited recovery APIs
  without a second hook instance.

Task 2 request-error rendering, pending submission lifecycle, successful
mutation clearing, and cache onSuccess race correction are intentionally not
implemented here. Root owns its separate submission helper files; they are
excluded from this commit.

## Test-first evidence

- Storage behavior cases initially failed because the draft module/API did not
  exist. The initial harness needed correction for Vitest's dynamic-import
  rewriting, then all six real-browser cases failed on the missing module.
- Hook tests initially failed on the missing hook module.
- Selection regression failed with expected restored `chosen-codex`, actual
  `undefined`; after initial implementation its provider-switch assertion also
  caught an external-snapshot reference reset, which was corrected.
- Form regressions failed because reopening yielded empty instructions and
  default Claude options instead of the saved prompt/Codex selection.
- Board regressions failed because Resume draft was absent on desktop/mobile.
- Full-suite verification exposed independent integration fixture cases
  inheriting the newly durable project draft. Both failures are documented
  below; explicit per-case storage cleanup preserves their independent-task
  assumptions.

RED commands:

```sh
pnpm test src/client/features/kanban/workspace-creation-draft-storage.test.ts
pnpm test src/client/features/kanban/use-workspace-creation-draft.test.tsx
pnpm test src/client/features/session-selection/use-session-launch-selection.test.tsx
pnpm test src/client/features/kanban/inline-workspace-form.test.tsx
pnpm test src/client/features/kanban/kanban-board.test.tsx
```

The Chromium storage cases now live in a dedicated Playwright suite, so regular
Vitest/CI does not require a browser installation. No new dependency was added.

GREEN commands/results:

```sh
pnpm test src/client/features/kanban/inline-workspace-form.test.tsx src/client/features/kanban/use-workspace-creation-draft.test.tsx src/client/features/kanban/kanban-board.test.tsx src/client/features/kanban/workspace-creation-draft-storage.test.ts src/client/features/session-selection/use-session-launch-selection.test.tsx
# 5 files, 51 tests passed
pnpm test src/test-utils/session-launch-controls.integration.test.tsx
# 1 file, 10 tests passed
pnpm exec playwright test --config=playwright.drafts.config.ts
# 6 tests passed in installed Chromium
pnpm typecheck
# passed
pnpm check
# passed with approved escalation for tsx IPC
pnpm check:fix
# passed after correcting Task 1 lint diagnostics and root helper diagnostics
```

The browser tests cover refreshed attachment contents, project isolation,
immediate reads before pending persistence completes, serialized saves/clears,
late old saves after clear, malformed records, bounded blocked opening, and
quota failure with retained memory. Hook/form cases cover remount/discard,
original-project async attachment ownership, hydration gating/error visibility,
restored textarea height, provider choices, ratchet and periodic schedule.

Storybook checks used the running server at port 16436. RestoredDraft,
RestoredDraftNarrow (375px), and UnrestorableDraft rendered correctly, with no
horizontal page overflow. Screenshots were inspected; Discard appears on its own
row to preserve narrow launch controls. Screenshots are temporary evidence at
`/tmp/task1-restored-draft.png`, `/tmp/task1-restored-draft-narrow.png`, and
`/tmp/task1-unrestorable-draft.png`.

## Checks and limitations

- Full `pnpm test` finished: 899 files passed, 1 failed, 2 skipped; 9856 tests
  passed, 2 failed, 3 skipped. Output is in `/tmp/task1-full-tests.log`. It
  exposed two integration fixture failures:
  `sends the selected thinking and Plan from the actual inline workspace composer`
  and
  `sends a manual account through the real picker, catalog, launch options and workspace payload`.
  Their shared project cache now deliberately persists across remounts; fixture
  cleanup was added and all ten integration tests passed on rerun. Root will run
  the final full suite after Task 2 integration.
- Sandbox execution blocks tsx IPC pipes and browser local listeners. Browser
  suites and full checks use approved escalation; no approval was rejected.
- Browser-local, same-window caching is intentional. Cross-device and live
  cross-tab draft synchronization are outside the approved scope.
- The form test file is 963 lines, below the 1000-line ceiling; split fixtures
  before adding substantial Task 2 coverage. No file-length baseline grows.
- Commit identifier and final check output are recorded in the completion
  message accompanying this report.

## Commit

Implementation and initial report: `a7b18a82d` — Preserve project task creation
drafts across navigation. Pre-commit formatting, lint, typecheck, Prisma drift,
dependency boundaries, and Knip checks all passed. The two root-owned submission
helper files remain uncommitted and outside Task 1.
