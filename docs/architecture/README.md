# Architecture Notes

Deep context for subsystems whose current shape is hard to infer from the code
alone — the rationale, the constraints, and the mistakes already made and fixed.

`AGENTS.md` at the repo root carries the rules you need in every session. These
files carry what you need only when you are working in the subsystem; a guide
beside the code leaves the "why" to [decision records](../decisions/). Read the
one that matches your change before you touch it.

| File                                         | Covers                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [background-jobs.md](./background-jobs.md)   | `jobRunner`, every registered poll loop, cadences, shutdown semantics                      |
| [Pull request guide][pr-guide]               | PR monitoring, observations, event delivery, GitHub coordination (beside the code)         |
| [workspace-state.md](./workspace-state.md)   | Kanban, needs-input status, completion notices, phone tools, families, board views         |
| [agent-runtime.md](./agent-runtime.md)       | ACP runtime, provider sub-agents, child workspaces, quick actions, desktop backend process |
| [integrations.md](./integrations.md)         | GitHub, Linear, periodic tasks                                                             |
| [file-previews.md](./file-previews.md)       | Bounded file reads, UTF-8 truncation, untracked diff limits                                |
| [client-loading.md](./client-loading.md)     | Route chunks, diagram loading, startup bundle, HTTP compression, query/mutation failures   |
| [client-state.md](./client-state.md)         | State resets by identity, latest-value refs, debounced values, following log output        |
| [search.md](./search.md)                     | Metadata query bounds, Unicode matching, search navigation                                 |
| [diff-rendering.md](./diff-rendering.md)     | Workers, virtual rows, scroll anchors, visual verification                                 |
| [Chat feature guide][chat-feature-agents-md] | Chat client: frames, loading, reducer, transcript (beside the code)                        |

[pr-guide]: ../../src/backend/orchestration/pull-requests/AGENTS.md
[chat-feature-agents-md]: ../../src/client/features/chat/AGENTS.md

Keep these true. Change a note when ownership, an invariant, a public surface,
the map or a reason changes. Do not add a description of new behaviour; its
tests hold it.

The [documentation index](../README.md) distinguishes current guides from
proposals, design records, and historical implementation plans.
