# Mobile task creation implementation plan

**Goal:** After successful mobile task creation, select Working and show the
newest card at the top. Preserve cancellation, failure and desktop behavior.

**Architecture:** Pass a success callback from the board into its To Do column.
Remount the mobile column scroll container when the selected tab changes; the
existing newest-first sort and optimistic cache expose the new card immediately.

**Tech stack:** React, TypeScript, Vitest, Storybook, Playwright.

## Task: Reveal the created task

- [x] Add a regression proving successful creation selects Working and reveals
      the created card with the column scrolled to the top; cover cancellation
      and desktop behavior.
- [x] Run the regression and confirm the existing behavior fails.
- [x] Add the mobile-only success callback and reset the column scroll container
      on tab changes. Keep failure handling in the creation form unchanged.
- [x] Add a mobile setup-state story and update the workspace state guide.
- [x] Run focused tests, repository checks, full tests, mobile E2E and
      Storybook.
- [ ] Inspect the diff, commit, push, and create the requested PR.
