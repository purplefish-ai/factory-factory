# Queued Message Steering Implementation Plan

> **For agentic workers:** Use test-driven implementation and independent
> review.

**Goal:** Keep default queueing and let a user explicitly steer one queued
message into the current provider turn.

**Architecture:** Use the existing ACP extension transport and native
`_session/steering`, retaining the host-owned `promptRequired` fallback. Queue
ownership and turn lifecycle remain in the session capsule. Client actions send
only the queued message ID; the server uses its validated stored content.

**Tech Stack:** TypeScript, ACP SDK, React, Vitest, Storybook.

**Spec:** User request in this conversation: retain queueing, add a Steer button
to queued messages, verify actual delivery, and create a PR.

## Constraints and review focus

- Normal submission continues to queue; only explicit Steer uses the extension.
- Native Claude steering may pre-empt generation; no promise of step-boundary
  delivery.
- Failed steering keeps the message queued; idle races use ordinary dispatch.
- Duplicate requests, cancellation, stop/restart, and simultaneous completion
  must not duplicate delivery or mutate a replacement runtime.
- Attachments follow normal validation; steering cannot change active-turn
  settings.
- Background notifications and slash commands are not eligible for steering.

## Tasks

- [x] Add failing runtime tests, implement capability capture and validated
      `steerSession`, and run adapter tests plus an opt-in live steering test.
- [x] Add failing client interaction tests, implement Steer alongside Cancel,
      thread callbacks through both chat surfaces, and update stories.
- [x] Add failing queue tests, implement guarded queue steering and typed
      websocket routing, and test successful delivery, failures, and lifecycle
      races.
- [x] Update runtime documentation; run formatting, types, full tests,
      integration tests, Storybook verification, and final checks. Review,
      commit, push, open PR.

## Review and verification

Independent review identified two queue wake-up races: a failed steer after turn
completion, and pending steering ownership surviving stop/reset. Both received
failing regressions before fixes. Pending ownership now uses resettable tokens;
old completions cannot clear a replacement claim or restore cleared input.
Accepted input wins a concurrent cancellation because the provider consumed it.

Live managed Codex and Claude tests both accepted steering while the original
prompt was unresolved and returned the injected marker. Desktop and narrow
mobile Storybook verification cover the action layout and interaction.

Final checks: 9,996 Vitest tests passed (four skipped), 273 integration tests
passed (four skipped), and all repository checks/typechecking passed. The mobile
suite passed 49/50 initially; the iPhone 14 composer-position baseline passed in
isolation. This fixture does not render the changed queued-message component.
