# Agent-definition Slack services

Token validation, the listener, message context and connection recovery for
Slack triggers. The [service guide](../AGENTS.md) covers evaluation and history,
and the [capsule guide](../../AGENTS.md) the models, the public surface and
saved management. Bare file names are in this directory; paths starting with
`src/` are from the repository root.

## Owns, and does not own

The Slack services own token validation, which connections hold a socket, what
an envelope stores and what context a run reads. They do not own:

- What Slack stores (tokens, source health, activation): the
  [Slack resources guide](../../resources/slack/AGENTS.md).
- The Socket Mode client and the intake job:
  `src/backend/orchestration/agents/`.

## Invariants

- Unless `AGENT_SLACK_INTAKE_ENABLED` is exactly `true`, a Slack trigger with no
  unsupported filter reads `SLACK_INTAKE_UNAVAILABLE`, Enable starts none and no
  socket opens. `slack-activation.integration.test.ts`,
  `slack-event-source.integration.test.ts`,
  `src/backend/services/config.service.test.ts`,
  `src/backend/trpc/agent-slack-activation.integration.test.ts`.
- An app-level token is saved only when `bots.info` gives the bot's app and
  `apps.connections.open` names no other, and survives a new bot token only if
  that bot is in the same app. `slack-app-token.integration.test.ts`.
- The listener holds a socket only for a connection with an app-level token
  whose listening trigger, on an active project, selects a channel, and refuses
  connections that share an app (`SLACK_APP_SHARED`).
  `slack-event-source.integration.test.ts`.
- A `hello` naming another app, or an `events_api` envelope naming another app
  or workspace, stores nothing, is not acknowledged and stops listening until
  the credentials change or a restart. `slack-event-source.integration.test.ts`.
- A stored message is acknowledged only after its insert commits.
  `slack-event-source.integration.test.ts`.
- Stopping the listener disconnects every socket, then waits for envelopes in
  flight before it records the stop. `slack-event-source.integration.test.ts`.
- Context reads only a selected channel, nothing after the triggering message,
  and fails whole. `slack-event-context.test.ts`,
  `src/backend/services/agent-definition/service/agent-event-slack-context.integration.test.ts`.

## Hazards

Context reads are Slack Tier 3 for internal apps; Slack's limits for
commercially distributed non-Marketplace apps would rate-limit them.

## Map

- `slack-connection.service.ts`, `slack-app-identity.ts` (tokens),
  `slack-api.ts`, `slack-sources.ts` (channels), `slack-event-source.ts`
  (listener), `slack-event-message.ts`, `slack-event-context.ts` (run context),
  `slack-connection-recovery.ts` (recovery).
