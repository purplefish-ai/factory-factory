# Workspace Family Navigation Implementation Plan

> Execute inline using test-driven development. The approved design is the
> parent links, breadcrumb, family menu and relationship icons discussed in
> chat, with hover highlighting replacing the proposed Show family button.

**Goal:** Make workspace parentage apparent and navigation between related
workspaces easy while preserving independent Kanban states.

**Architecture:** Extend the existing workspace summary with optional family
metadata, carried through HTTP and snapshots. Render shared family navigation in
cards and the workspace header. Board-level hover/focus state highlights related
cards across columns without fetching, moving, or hiding workspaces.

**Tech stack:** TypeScript, React, tRPC, Prisma, Vitest, Storybook.

## Constraints and review focus

- Use the existing isolated branch and pinned Node/pnpm; no schema migration.
- Cross-project and archived parents retain usable names and links.
- Hover/focus resets on leave, project changes and workspace removal.
- Pointer highlighting does not obscure keyboard focus or other status signals.
- Parent links and family controls must not activate the enclosing card.
- Loading/errors must not imply an empty family; lazy menus offer retry.

## Task 1: Family metadata

- [x] Add failing projection tests for cross-project parent and child count,
      including optional legacy summaries and snapshot updates.
- [x] Run focused tests and confirm the missing metadata causes failure.
- [x] Add selected family relations at the workspace read boundary, summary
      schemas, and metadata policy; preserve legacy optional fields.
- [x] Verify projection, snapshot, reconciliation, and resource tests.

## Task 2: Parent and family navigation

- [x] Add failing tests for named parent links, cross-project routes, family
      members in independent states, current-row marking, errors and retry.
- [x] Implement shared parent link and family-menu components, exposed through
      the workspace barrel. Load family details only when the menu opens.
- [x] Place the breadcrumb and menu in the workspace header and relationship
      controls on Kanban cards. Keep separate valid links and buttons.
- [x] Verify focused UI tests and add stories for family menus and long names.

## Task 3: Hover/focus and delivery

- [x] Add failing tests for parent, child and sibling highlighting across
      Working/Waiting/Done, unrelated cards, pointer leave and keyboard blur.
- [x] Add board-level relationship highlighting and a cross-column story.
- [x] Update the current workspace-state guide.
- [x] Run required formatting, types, tests, checks, Storybook and mobile
      checks.
- [ ] Commit, push and open a PR after the final checks.

## Review and verification notes

- Metadata projection/snapshot tests: 234 passed; expanded focused checks: 211
  passed. Accessor expectations now include selected family relations.
- All 62 mobile/browser tests passed, including parent routes and readable
  current-workspace labels at 375, 768, 810, 1024 and 1280 CSS pixels.
- Storybook browser checks verified family hover/focus and independent menu
  states. Independent review found metadata whitespace intercepting the card
  link; a browser reproduction failed before the pointer-event fix and passed
  afterward. The cross-column story retains that regression check.
- Cubic review reported no findings. No review findings remain deferred.
- The full-suite run hit a five-second timeout in the unrelated source-recovery
  test `uses the application graph GitHub reads and page limit lazily`; its
  complete file passed all 14 tests when rerun separately.

Final checks: `pnpm check` and `pnpm typecheck` passed. The full suite had
11,590 passing tests and the one timeout described above; its isolated rerun
passed. The browser suite passed all 62 tests.
