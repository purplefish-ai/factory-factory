# Documentation

Start with the current guides below. Design documents and execution records
capture decisions at a point in time; their implementation steps are historical
context, not a new task or a substitute for current repository guidance.

## Current guides

| Need                                               | Start here                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Install and run                                    | [README](../README.md)                                                                                                       |
| Product vocabulary and UI labels                   | [Workspace glossary](workspaces.md#glossary)                                                                                 |
| Logo source and installation icons                 | [Brand assets](brand-assets.md)                                                                                              |
| Contribute and verify changes                      | [Verification](../CONTRIBUTING.md#verification) and [agent guide](../AGENTS.md)                                              |
| Service boundaries and subsystem contracts         | [Architecture notes](architecture/README.md)                                                                                 |
| Where a rule, fact or tool for agents belongs      | [Agent-friendly codebase principles](architecture/agent-friendly-codebase.md)                                                |
| Why a decision was made                            | [Decision records](decisions/)                                                                                               |
| Chat streaming, loading, and replay                | [Chat message flow](chat-message-flow.md)                                                                                    |
| Workspace state and PR monitoring                  | [Workspace state](architecture/workspace-state.md) and [PR monitoring](../src/backend/orchestration/pull-requests/AGENTS.md) |
| Mixed Automations management and scheduled history | [Scheduled automations](architecture/integrations.md#scheduled-automations)                                                  |
| Event automation limits and checks                 | [Event automation limits](architecture/integrations.md#current-event-automation-limits)                                      |
| User and project configuration                     | [Settings](admin-settings.md)                                                                                                |
| Maintain UI primitives and dependencies            | [shadcn](shadcn.md) and [Knip](knip.md)                                                                                      |
| Button sizes, icon buttons and tooltips            | [Buttons and tooltips](shadcn.md#buttons-icon-buttons-and-tooltips)                                                          |
| Write and organize Storybook stories               | [Storybook](storybook.md)                                                                                                    |
| Theme tokens and status colors                     | [Status colors](status-colors.md)                                                                                            |
| Terminal palette and live appearance changes       | [Terminal theme](terminal-theme.md)                                                                                          |
| Package npm runtime dependencies                   | [npm package security](npm-package-security.md)                                                                              |
| Audit vulnerabilities and dependency updates       | [Dependency security](dependency-security.md)                                                                                |
| Sign and notarize desktop releases                 | [Desktop releases](desktop-releases.md)                                                                                      |
| Container image integrity                          | [Distribution security](distribution-security.md)                                                                            |
| Verify npm release artifact identity               | [npm release security](npm-release-security.md)                                                                              |

For implementation work, search the relevant source area and current guides
first, for example `rg -n 'PR monitoring' docs/architecture`. Consult historical
records when the task needs an earlier decision or migration.

Keyboard behavior is documented in [Keyboard shortcuts](keyboard-shortcuts.md).

UI writing follows the [copy guide](architecture/client-copy.md); loading and
query recovery follow [client loading](architecture/client-loading.md); state
resets, refs and effects follow [client state](architecture/client-state.md).

## Proposals and design records

[Design records](design/README.md) distinguish proposals from implemented
designs. The [cloud vision](design/factory-factory-cloud-vision/README.md)
remains a proposal; its plans do not describe the shipped local application.

The [GitHub webhook intake](design/github-webhook-intake.md) note is a proposal
for receiving GitHub events beside the shipped issue-event polling.

## Historical work

Plans, specs, milestone records, execution reports and superseded design
documents were removed from `main` and are preserved at the tag
`docs-archive-2026-11`. Read one with `git show docs-archive-2026-11:<path>`,
and list a directory with
`git ls-tree -r --name-only docs-archive-2026-11 -- <dir>`; the removed
directories include `.planning`, `.architecture`, `.superpowers`, the completed
plans and specs under `docs/superpowers` and the design archive under
`docs/design`. Check current behavior in source and the architecture notes
before using their examples. The
[workspace progression](workspaces.md#historical-progression-model) section
describes the former Ratchet fixer and PR-state model.
