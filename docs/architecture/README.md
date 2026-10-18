# Architecture Notes

Deep context for subsystems whose current shape is hard to infer from the code
alone — the rationale, the constraints, and the mistakes already made and fixed.

`AGENTS.md` at the repo root carries the rules you need in every session. These
files carry the "why" you need only when you are working in the subsystem. Read
the one that matches your change before you touch it.

| File                                         | Covers                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [background-jobs.md](./background-jobs.md)   | `jobRunner`, the five poll loops, cadences, shutdown semantics    |
| [pull-requests.md](./pull-requests.md)       | PR monitoring, observations, event delivery, GitHub coordination  |
| [workspace-state.md](./workspace-state.md)   | Run script, auto-iteration state, the Kanban column projection    |
| [agent-runtime.md](./agent-runtime.md)       | ACP runtime, provider sub-agents, child workspaces, quick actions |
| [integrations.md](./integrations.md)         | GitHub, Linear, periodic tasks                                    |
| [file-previews.md](./file-previews.md)       | Bounded file reads, UTF-8 truncation, untracked diff limits       |
| [client-loading.md](./client-loading.md)     | Route chunks, diagram loading, startup bundle measurement         |
| [diff-rendering.md](./diff-rendering.md)     | Workers, virtual rows, scroll anchors, visual verification        |
| [Chat message flow](../chat-message-flow.md) | ACP streaming, session loading, replay, client reduction          |

Keep these current. When behaviour changes, update the note in the same PR — a
stale rationale is worse than no rationale, because it is believed.

The [documentation index](../README.md) distinguishes current guides from
proposals, design records, and historical implementation plans.
