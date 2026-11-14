# Agent-authoring feature: the chat proposal card

An automation proposed in chat: finding the proposal in a tool result, the
editable card that creates the automation or saves changes to it, and combining
a newer revision from chat with the user's edits. The
[features guide](../AGENTS.md) covers barrels and shared code. Bare file names
below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This directory owns what the card shows, what it sends and how it reconciles
revisions. It does not own:

- The agent's tools and their guidance:
  `src/backend/mcp/automation-authoring-tools.ts`.
- Proposals, their revisions and acceptance: the
  [agent-definition capsule guide](../../../backend/services/agent-definition/AGENTS.md).
- Which cached reads a save invalidates: `src/client/lib/agent-query-cache.ts`.
- The Automations page: the [agents feature guide](../agents/AGENTS.md).

## Public surface

`index.ts` exports `AgentProposalCard`, `extractAgentProposal` and
`AgentTriggerEditor`.

## Invariants

- A proposal is read only from the results of the proposal tools, under their
  current or older names. `agent-proposal-result.test.ts`.
- When chat and the card both changed the events, a newer revision is not loaded
  until the user discards the local event edits; other fields keep a local edit
  and take chat's change otherwise. `agent-proposal-draft.test.ts`,
  `agent-proposal-card.test.tsx`.
- Saving a created automation from the card refreshes that automation's reads in
  the project that owns the authoring workspace.
  `agent-proposal-cache.test.tsx`.

## Map

- `agent-proposal-result.ts`: finding a proposal reference in a tool result.
- `agent-proposal-card.tsx`, `agent-trigger-editor.tsx`: the card and its event
  editor; `agent-proposal-draft.ts`: drafts and reconciliation.
- `src/backend/services/session/service/acp/agent-authoring.manual.integration.test.ts`
  evaluates the server authoring flow against live Codex and runs only with
  `RUN_AGENT_AUTHORING_EVAL=1`.

## Decisions

- [Chat and card event edits are not merged](../../../../docs/decisions/2026-11-14-chat-and-card-event-edits-are-not-merged.md)
