# Mobile header implementation plan

## Design

Every phone screen uses the shared AppHeader: hamburger plus breadcrumb or page
name first, status and action controls second. Keep both rows consistent in
height, truncate long paths, and preserve desktop and installed PWA geometry.
Use CSS grid on phones with the existing portal targets so controls keep their
React context and keyboard order. Move the extra/status slot after the path in
the DOM. A separate mobile component would duplicate portal targets and state;
CSS ordering alone would leave keyboard order inconsistent with the screen.

## Steps

- [x] Add browser regression checks for row placement across workspace, family,
      project and generic screens at 320px and 390px; verify failure first.
- [x] Adjust shared header markup and responsive CSS; preserve PWA flex layout.
- [x] Cover phone states in Storybook and document the shared layout contract.
- [ ] Run formatting, typecheck, unit, Storybook and mobile checks; inspect
      diff.
- [ ] Open a PR, address valid review feedback, and merge only after checks pass
      and no review comments remain outstanding.
