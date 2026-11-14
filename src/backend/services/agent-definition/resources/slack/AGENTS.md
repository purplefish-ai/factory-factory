# Agent-definition Slack resources

What Slack stores: tokens, listener health and test-message activation. The
[resources guide](../AGENTS.md) covers the ledger and GitHub proof, and the
[capsule guide](../../AGENTS.md) the models and the public surface. Bare file
names are in this directory; paths starting with `src/` are from the repository
root.

## Owns, and does not own

This directory owns what Slack stores. It does not own:

- Slack token checks and the listener: the
  [Slack services guide](../../service/slack/AGENTS.md).

## Invariants

- An app-level token is written only while the bot credential it was checked
  against is still the saved one.
  `src/backend/services/agent-definition/service/slack/slack-app-token.integration.test.ts`.
- An interrupted listener opens one delivery gap that its next verified
  connection closes, ceasing to listen on purpose (gate off, no listening
  trigger, no app-level token) closes any gap without opening one, stopping the
  listener at shutdown opens one, the cursor keeps the latest 100, and
  `RECOVERY_REQUIRED` is never overwritten. `slack-source-health.test.ts`,
  `src/backend/services/agent-definition/service/slack/slack-event-source.integration.test.ts`.
- A channel's test message counts only as a person's root message with no
  subtype, from the expected app, in a pending channel, observed by the expiry,
  whose whole text is this generation's message; the earliest is the boundary.
  `slack-verification.test.ts`,
  `src/backend/services/agent-definition/service/slack/slack-activation.integration.test.ts`.
- A starting Slack trigger whose connection changed app or was disabled returns
  to `PAUSED` with `SOURCE_ERROR`, and one unverified at its expiry with
  `ACTIVATION_EXPIRED`.
  `src/backend/services/agent-definition/service/slack/slack-activation.integration.test.ts`.

## Hazards

A Slack gap means events may have been missed: Slack can lose events while no
connection is open, and nothing recovers them.

## Map

- `slack-connection.accessor.ts` (tokens), `slack-source-health.ts` (health and
  gaps), `slack-activation.accessor.ts` and `slack-verification.ts` (test
  messages), `slack-connection-recovery.ts` (export and restore of connections).

## Decisions

- [Slack triggers activate on a posted test message](../../../../../../docs/decisions/2026-11-14-slack-triggers-activate-on-a-posted-test-message.md)
