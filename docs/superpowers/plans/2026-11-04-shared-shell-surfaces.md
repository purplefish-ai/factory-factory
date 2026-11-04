# Shared Shell Surfaces Implementation Plan

> Execute inline with superpowers:executing-plans.

**Goal:** Unify navigation surfaces and restore visible pane boundaries.
**Architecture:** A shared CSS surface token drives header, sidebar and tab
rows. Native title-bar geometry and drag regions remain intact. **Tech Stack:**
React, Tailwind CSS, Storybook, Vitest, Playwright. **Spec:**
docs/superpowers/specs/2026-11-04-shared-shell-surfaces-design.md

## Global constraints

Keep content surfaces distinct, preserve theme presets and native controls, use
pinned Node/pnpm, and open a separate PR without merging it.

## Review focus

Native title-bar separators, collapsed navigation, custom presets, high
contrast, and mobile header wrapping must retain visible boundaries and working
controls.

## Task: Shared surfaces and browser regression coverage

- [x] Add a shell composition story using the real header and main tab bar;
      assert matching sidebar/header/tab colors and a visible header separator.
- [x] Run the new stories before implementation and confirm the color/boundary
      regression fails.
- [x] Add `--shell` and `bg-shell`, align sidebar tokens in both CSS palette
      files, update app-header CSS/TSX, session/main tab rows and right-panel
      tool rows. Increase Factory dark borders from 15% to 22% white.
- [x] Run stories again; inspect real browser screenshots in light/dark, native
      controls, collapsed/expanded navigation, phone and preset modes.
- [x] Document appearance behavior in docs/admin-settings.md; run check:fix,
      typecheck, test, test:storybook and check. Report unrelated failures.
- [ ] Review the final diff, commit, push, and open the separate PR.

## Review resolution

A read-only reviewer found reduced contrast for sidebar metadata on the new
selection tint. Browser tests reproduced it. Factory selection tints now use 5%
foreground in light mode and 6% in dark mode; shipped preset selection colors
remain. One/Solarized light muted text is darker, and Solarized light's shell is
slightly lifted to keep header text readable. The browser regression checks
muted metadata at 4.5:1 on every active-row surface.

## Validation

All 13 shell browser stories pass. Screenshots reviewed for light/dark and
native controls with expanded/collapsed navigation. Typecheck, check:fix, and
check pass. Full Storybook: 1,193 passed; existing Mermaid Factory Light story
failed. Full application suite: 14,240 passed, 16 failures across 13 unchanged
files (mostly five-second timeouts); isolated two-worker reruns are recorded in
the PR.
