# Agent-definition services: event evaluation

This guide so far covers how one event is evaluated against one trigger,
natural-language filters included; the migration of the Slack sections of the
integrations note adds the Slack services here, extending Owns, Invariants and
Map in place. The [capsule guide](../AGENTS.md) covers the models, the public
surface and saved management. Bare file names below are in this directory; paths
that start with `src/` are from the repository root.

## Owns, and does not own

Evaluation owns the order of checks for a trigger and an event: stored data,
eligibility, the deterministic match, execution settings, Slack context, then
the filter; and how a classifier outcome becomes a decision. It does not own:

- Recording decisions, retry times and admission: the
  [resources guide](../resources/AGENTS.md).
- The classifier call, `classifyAgentEvent` in `src/backend/services/session/`,
  and its port: `src/backend/orchestration/agents/`.
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

The gate test does not notice changed prompt text under the same version: the
comment on the version in `src/backend/prompts/agent-event-classification.ts` is
the only guard.

## Map

- `agent-event-evaluation.service.ts`: one pass over pending decisions and the
  order of checks; `agent-event-matcher.ts`: the deterministic match.
- `agent-semantic-filter.ts`: classifier outcomes as decisions;
  `semantic-filter-gate.ts`: which providers passed.
- `src/backend/services/agent-definition/testing/classifier-fixtures.json` and
  `src/backend/services/agent-definition/testing/classifier-gate.json`: the
  replay fixtures and the gate record.
  `src/backend/services/session/service/acp/agent-event-classifier.manual.integration.test.ts`
  runs the live gate; its header has the command.

## Decisions

- [Natural-language filters pass a fixture gate per provider](../../../../../docs/decisions/2026-11-14-natural-language-filters-pass-a-fixture-gate-per-provider.md)
