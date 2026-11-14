# Agent-definition services: evaluation, history and Slack

How one event is evaluated against one trigger, natural-language filters
included, what history reads may return, and the Slack services. The
[capsule guide](../AGENTS.md) covers the models, the public surface and saved
management. Bare file names are in this directory; paths starting with `src/`
are from the repository root.

## Owns, and does not own

Evaluation owns the order of checks for a trigger and an event: stored data,
eligibility, the deterministic match, execution settings, Slack context, then
the filter; how a classifier outcome becomes a decision; and what history reads
may return. The Slack services own token validation, which connections hold a
socket, what an envelope stores and what context a run reads. Neither owns:

- Recording decisions, retry times and admission, and what Slack stores (tokens,
  source health, activation): the [resources guide](../resources/AGENTS.md).
- The classifier port, the Socket Mode client and the intake job:
  `src/backend/orchestration/agents/`; the classifier call itself:
  `classifyAgentEvent` in `src/backend/services/session/`.
- The prompt and its output schema:
  `src/backend/prompts/agent-event-classification.ts`.
- Classifier models, time limit and concurrency:
  `configService.getAgentEventClassifierConfig()`.

## Invariants

- Only a deterministic match on a trigger with `filterInstructions` reaches the
  classifier, so a filter narrows a trigger's scope and never widens it.
  `agent-event-semantic-filter.integration.test.ts`.
- On a trigger with `filterInstructions`, only a classifier `match` admits a
  run: `skip`, `uncertain`, a missing classifier port and an unproven provider
  never do. `agent-event-semantic-filter.integration.test.ts`,
  `src/backend/testing/agent-runtime-flow.integration.test.ts`.
- Evaluation checks the gate for the provider resolved for each event and, when
  it has not passed, records `SEMANTIC_FILTER_PROVIDER_UNPROVEN` without a
  classifier call. `agent-event-semantic-filter.integration.test.ts`.
- An ordinary read, which does not resolve the provider, shows a filter on an
  inherited provider as supported only when every provider passed.
  `semantic-filter-gate.test.ts`.
- A filter longer than 4,000 characters is never sent to a provider and records
  a terminal `SEMANTIC_FILTER_TOO_LONG` error.
  `agent-event-semantic-filter.integration.test.ts`.
- `uncertain` and malformed outcomes are terminal; timeouts, rate limits and
  provider failures, thrown or returned, retry on the evaluation's budget.
  `agent-event-semantic-filter.integration.test.ts`.
- A decision stores the classifier's identity when a call ran and only fixed
  explanations, never the classifier's reason text.
  `agent-event-semantic-filter.integration.test.ts`,
  `agent-evaluation-explanations.test.ts`.
- A Slack context failure is an error recorded before any classifier call.
  `agent-event-slack-context.integration.test.ts`.
- `PROVEN_CLASSIFIER_PROVIDERS` lists exactly the providers that passed in the
  gate record, and a configured classifier model or prompt version that differs
  from the record fails the gate test. `semantic-filter-gate.test.ts`.
- History returns no snapshot, input, error message or provider evidence, reads
  a stored reason that is not a code as `INVALID_STORED_DATA`, and returns an
  `explanation` only when it is a fixed sentence in
  `src/backend/services/agent-definition/resources/agent-evaluation-explanations.ts`.
  `agent-management-owner.integration.test.ts`,
  `agent-evaluation-history.integration.test.ts`.
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
  `agent-event-slack-context.integration.test.ts`.

The gate test does not notice changed prompt text under the same version: the
comment on the version in `src/backend/prompts/agent-event-classification.ts` is
the only guard. Context reads are Slack Tier 3 for internal apps; Slack's limits
for commercially distributed non-Marketplace apps would rate-limit them.

## Map

- `agent-event-evaluation.service.ts`: one pass over pending decisions and the
  order of checks; `agent-event-matcher.ts`: the deterministic match.
- `agent-semantic-filter.ts`: classifier outcomes as decisions;
  `semantic-filter-gate.ts`: which providers passed.
- `agent-history-projection.ts`: what history may return.
- Slack: `slack-connection.service.ts`, `slack-app-identity.ts` (tokens),
  `slack-api.ts`, `slack-sources.ts` (channels), `slack-event-source.ts`
  (listener), `slack-event-message.ts`, `slack-event-context.ts` (run context),
  `slack-connection-recovery.ts` (recovery).
- `../testing/classifier-fixtures.json` and `../testing/classifier-gate.json`:
  the replay fixtures and the gate record.
  `src/backend/services/session/service/acp/agent-event-classifier.manual.integration.test.ts`
  runs the live gate; its header has the command.

## Decisions

- [Natural-language filters pass a fixture gate per provider](../../../../../docs/decisions/2026-11-14-natural-language-filters-pass-a-fixture-gate-per-provider.md)
