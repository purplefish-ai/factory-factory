# Thinking Footer Implementation Plan

**Goal:** Prevent live thinking updates from moving the conversation.
**Architecture:** An optional ChatTranscript footer reserves space outside its
viewport. Workspace and quick chat opt in; read-only surfaces retain their
current presentation. **Tech Stack:** React, Tailwind, Radix Popover, Vitest,
Playwright. **Spec:** ../specs/2026-10-31-thinking-footer-design.md

## Constraints

Use pinned Node and pnpm, preserve background activity and scroll behavior,
respect reduced motion, and keep the preview to one line at narrow widths.

## Task 1: Fixed thinking footer

- [x] Add regression tests for placement outside the viewport, long/empty text,
      idle retention, autonomous turns, and preserved background controls.
- [x] Run focused tests and observe failure before implementation.
- [x] Add a fixed-height preview with opacity-only fade and a full-text popover;
      opt in workspace and quick chat and suppress duplicate inline thinking.
- [x] Add interactive Storybook coverage and a browser geometry regression.
- [x] Run focused tests, browser checks, repository formatting, typecheck, full
      tests and checks; inspect the final diff.

## Review focus

Completion and text wrapping must not resize the viewport; virtualized rows must
not remount the footer; idle controls must not be focusable; autonomous turns
must still show activity; background-only work must remain visible.

## Verification results

- Pinned Node 26.12.1 and pnpm 12.15.0.
- `pnpm check:fix`, `pnpm typecheck`, and `pnpm check` passed.
- `pnpm test`: 9,730 passed, 3 skipped (886 files passed, 2 skipped).
- Focused chat tests: 753 passed.
- New desktop/mobile thinking geometry regression: both passed.
- Storybook: thinking, long preview, idle, dark, and activity changes checked at
  375px; reduced motion disables transitions and spinner animation.
- Full transcript browser suite: 39 passed, one existing desktop wheel-scroll
  test failed at `transcript-scroll.spec.ts:118`. It also failed on the original
  code in four of five repeats. No scroll-policy changes were made to mask it.
- Independent code review found no important correctness issues.
