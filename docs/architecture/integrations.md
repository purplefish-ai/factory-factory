# Integrations

This note has moved. Ownership, public surface, invariants and maps are in the
guides beside the code:

- [GitHub capsule](../../src/backend/services/github/AGENTS.md),
  [Linear capsule](../../src/backend/services/linear/AGENTS.md) and
  [periodic-task capsule](../../src/backend/services/periodic-task/AGENTS.md):
  GitHub reads, Linear and scheduled automations.
- [Agent-definition capsule](../../src/backend/services/agent-definition/AGENTS.md)
  and its
  [service](../../src/backend/services/agent-definition/service/AGENTS.md) and
  [resources](../../src/backend/services/agent-definition/resources/AGENTS.md)
  guides: event automations, the run ledger, Slack tokens, the Slack listener,
  message context and activation.
- [Event automation orchestration](../../src/backend/orchestration/agents/AGENTS.md):
  the runtime's jobs, Slack intake, saved management and authoring.
- [Automations page](../../src/client/features/agents/AGENTS.md) and
  [agent authoring](../../src/client/features/agent-authoring/AGENTS.md).
- [Client library](../../src/client/lib/AGENTS.md): the tRPC client's transport.

The reasons are in the `2026-11-13-*` and `2026-11-14-*` records in
[decisions](../decisions/), and the tests those guides name describe the
behaviour. Slack app setup, turning a Slack automation on and the current limits
are in [Settings](../admin-settings.md#slack-automations); the end-to-end checks
are a [recipe](../recipes/verify-event-automations.md).

This page remains as long as the section below holds entries; delete it when it
is empty.

## Held for other guides

Rules, hazards and reasons from the migrated sections that belong to another
area. Each entry quotes only the sentences it needs from the paragraph named
after it, verbatim, with `[…]` where sentences between them are left out. The
migration that creates the named area's guide checks the entry, moves what holds
there and deletes the entry here. Paragraph numbers are the rows of the
disposition table in pull request #3238.

> Coordination is in-process and uses lexically resolved paths; filesystem
> aliases such as symlinks to the same directory are not coordinated.

Old paragraph 5. For the workspace capsule (`src/backend/services/workspace/`):
the guide of the directory that owns cloning.

> Default sessions use the `periodic-task` workflow, so non-interactive Codex
> startup selects unattended execution mode and tool approval prompts cannot
> stall scheduled runs.

Old paragraph 27. For the session capsule guide.
