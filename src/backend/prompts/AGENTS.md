# Backend prompts

The texts the backend gives agents: PR update messages, quick actions, the
adversarial review dispatch, and the instructions and input of disposable
inference tasks (workspace metadata, event classification). Bare file names
below are in this directory; paths that start with `src/` or `prompts/` are from
the repository root.

## Owns, and does not own

This directory owns the wording of those texts and the bounds on their input.
Prompts state the outcome wanted and the automation contract; they may name a
tool an action needs, and leave repository-specific tools and verification
commands to the repository's own guidance. It does not own:

- The issue start prompt, shared with its editable preview:
  `src/shared/issue-start-prompt.ts`.
- The child workspace context:
  `src/backend/services/session/service/prompt/session.prompt-builder.ts`.
- When a PR update is sent and to which conversation:
  `src/backend/orchestration/pull-requests/`.
- Sending a prompt to a session: `src/backend/services/session/`.

## Invariants

- Agent sessions are created and loaded with no custom system prompt, so PR
  updates, agent quick actions and the review dispatch reach the agent as
  ordinary messages.
  `src/backend/services/session/service/acp/acp-client-factory.test.ts`.

## Hazards

Claude sessions run the SDK's Claude Code preset unchanged; before adding a
custom or appended system prompt, check how the SDK snapshots each.

## Map

- `pr-event.ts`: PR update batches, within a byte limit, and the monitoring
  control messages.
- `quick-actions.ts`: quick actions, read from `prompts/quick-actions/`.
- `adversarial-review-dispatch.ts`, `adversarial-review-findings.schema.ts`: the
  review dispatch, read from `prompts/adversarial-review/`, and its findings.
- `workspace-metadata.ts`, `agent-event-classification.ts`: inference
  instructions and input.
- `markdown-loader.ts`: front matter and caching for the markdown prompts.
