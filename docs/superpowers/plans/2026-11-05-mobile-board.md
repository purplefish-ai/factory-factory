# Mobile board implementation plan

**Goal:** Show all mobile board sections in one scrolling list, with sticky
section links and filtering across every section.

**Design:** The approved layout keeps hamburger, breadcrumbs and global search
in the shared first row. Board controls follow. Todo, Working, Waiting and Done
stack vertically on phones. Equal-width text links jump to sections and track
manual scrolling. Waiting sorting belongs in its heading, with a sort icon.
Desktop retains its horizontal board.

## Implementation

- [x] Add browser regressions for all sections, jump links, scroll tracking,
      filtering across columns, and workspace creation.
- [x] Add a private mobile section component owning the single scroll surface,
      stable section anchors, active-section tracking and creation scrolling.
      Integrate it in KanbanBoard and remove the old mobile tab selection.
- [x] Show column headings on mobile, keep their content in the parent scroll
      surface, and replace Waiting's ellipsis with a sort icon.
- [x] Update old tab-specific assertions to test the approved section behavior.
      Preserve project reset, draft, creation and archive coverage.
- [x] Update workspace-state documentation; run repository checks, application
      tests, affected Storybook states and the mobile suite. Capture final
      screenshots and open an unmerged PR.

## Review focus

Filtering must find matches in different sections. Sticky navigation must not
cover headings. Empty/error Todo states must remain available. Repeated New
workspace requests must return to an already-open composer. Project switching
must reset scroll and filtering without retaining the previous project's state.
