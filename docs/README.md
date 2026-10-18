# Documentation

Start with the current guides below. Design documents and execution records
capture decisions at a point in time; their implementation steps are historical
context, not a new task or a substitute for current repository guidance.

## Current guides

| Need                                         | Start here                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Install and run                              | [README](../README.md)                                                                                |
| Contribute and verify changes                | [Contributing](../CONTRIBUTING.md) and [agent guide](../AGENTS.md)                                    |
| Service boundaries and subsystem contracts   | [Architecture notes](architecture/README.md)                                                          |
| Chat streaming, loading, and replay          | [Chat message flow](chat-message-flow.md)                                                             |
| Workspace state and PR monitoring            | [Workspace state](architecture/workspace-state.md) and [PR monitoring](architecture/pull-requests.md) |
| User and project configuration               | [Settings](admin-settings.md)                                                                         |
| Maintain UI primitives and dependencies      | [shadcn](shadcn.md) and [Knip](knip.md)                                                               |
| Audit vulnerabilities and dependency updates | [Dependency security](dependency-security.md)                                                         |

For implementation work, search the relevant source area and current guides
first, for example `rg -n 'PR monitoring' docs/architecture`. Consult historical
records when the task needs an earlier decision or migration.

## Proposals and design records

[Design records](design/README.md) distinguish proposals from implemented
designs. The [cloud vision](design/factory-factory-cloud-vision/README.md)
remains a proposal; its plans do not describe the shipped local application.

The older top-level voice, agent-status, CORS, and notification design documents
are point-in-time records. Check current behavior in source and architecture
notes before using their examples.

## Historical work

- [Workspace progression](workspaces.md): the former Ratchet fixer and PR-state
  model; use the current workspace state and PR monitoring notes above.

- [Milestone planning and generated maps](../.planning/README.md): completed
  milestone records plus codebase snapshots from earlier revisions.
- [Superpowers specs and plans](superpowers/README.md): point-in-time design and
  execution records; checkboxes do not establish current implementation status.
- [Archived designs](design/archive/): superseded proposals and migration plans.
- [Dependency analysis](../.architecture/README.md): historical metrics and the
  script used to generate reports.
- [Execution reports](../.superpowers/sdd/README.md): earlier review/fix
  records.
