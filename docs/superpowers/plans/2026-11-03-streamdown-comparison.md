# Streamdown Comparison Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this
> plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the user-approved Streamdown renderer and retain the Storybook
comparison with the React Markdown baseline.

**Architecture:** Add an optional content-rendering adapter to the existing
Markdown primitive so both renderers share application links, images, styling
and Mermaid behavior. A client-owned Streamdown adapter uses word fades without
stagger and the existing URL policy. Storybook replays identical fixtures
through both renderers.

**Tech Stack:** React, TypeScript, Streamdown 2.7.1, Storybook, Vitest, pnpm.

**Spec:** Approved conversation: a small Storybook comparison using 100–120 ms
word fades, zero stagger, existing application components and identical
streaming fixtures.

## Global Constraints

- Use Streamdown for application Markdown and retain the 100 ms snapshot
  interval.
- Preserve workspace links, GitHub previews, image validation and literal HTML
  behavior.
- Load animation styles from the shared application stylesheet and preserve
  production bundle budgets.
- Disable reveal animation for reduced-motion preferences and settled messages.
- Treat Streamdown's backlog budget as soft; use zero stagger to avoid queued
  reveal.
- The approved fade configuration supersedes #2880's initial 80–120 ms total
  character-reveal target: budget 100 ms to a client snapshot and 120 ms to full
  opacity (220 ms total, approximately 245 ms with backend batching). Rendering,
  network and scheduling add to this nominal budget; it is not a wall-clock cap.
- Use the existing linked worktree, Node 26.12.1 and pnpm 12.15.0.

## Review Focus

- Link callback changes must not leave stale workspace handlers.
- Large bursts must not create staggered animation debt.
- Static and completed output must not retain animated spans.
- Local/data image sources must reach the existing image validator unchanged.
- Replay, restart and completion must keep both comparison panes on the same
  source text.

## Task 1: Shared rendering boundary and Streamdown adapter

**Files:** `src/components/ui/markdown.tsx`,
`src/client/components/streamdown-markdown.tsx`, co-located tests,
`package.json`, `pnpm-lock.yaml`.

**Interfaces:** Export `MarkdownContentProps` and an optional `renderContent`
callback from the Markdown primitive. Export `renderStreamdownContent` from the
client adapter for consumers to opt in.

- [x] Add a failing test proving the optional adapter receives transformed
      render options and replaces default parsing.
- [x] Add Streamdown 2.7.1 and implement the shared boundary and adapter.
- [x] Verify incomplete formatting, unchanged URL/image handling, literal HTML,
      callback updates, zero animation delay, reduced motion and completion
      using real Streamdown output.
- [x] Run focused Markdown tests and typecheck.

## Task 2: Comparison stories, rendering measurements and verification

**Files:** `src/client/components/streamdown-markdown.stories.tsx`, a co-located
benchmark, `docs/performance/streaming-markdown.md`.

**Interfaces:** Both panes use the same content snapshot and streaming state.
Stories cover ordinary prose, bursty delivery, long code, tables and diagrams,
and application links/images.

- [x] Add replay controls and fixtures, comparing current Markdown with
      zero-stagger Streamdown.
- [x] Add a repeatable benchmark covering a long settled prefix and a growing
      code fence; include Streamdown animation overhead.
- [x] Inspect comparison states in Storybook and document measurements and
      limits.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, `pnpm check`, and
      relevant build checks.
- [x] Review the final diff and report results, limitations and the Storybook
      entry point.

## Approved adoption follow-up

The user selected Streamdown after trying the comparison.

- [x] Make Streamdown the application Markdown default while retaining the
      explicit React Markdown comparison baseline.
- [x] Move animation CSS, reduced-motion fallback and Tailwind source discovery
      into the application's shared stylesheet.
- [x] Cover the default renderer and live transcript integration with tests.
- [x] Verify production bundles, transcript scrolling, Storybook and repository
      checks; keep the existing snapshot throttle.
