# Architecture Notes

Deep context for subsystems whose current shape is hard to infer from the code
alone — the rationale, the constraints, and the mistakes already made and fixed.

`AGENTS.md` at the repo root carries the rules you need in every session. These
files carry the "why" you need only when you are working in the subsystem. Read
the one that matches your change before you touch it.

| File | Covers |
| --- | --- |
| [background-jobs.md](./background-jobs.md) | `jobRunner`, the five poll loops, cadences, shutdown semantics |
| [pull-requests.md](./pull-requests.md) | Auto-Fix (Ratchet), the `WorkspacePR` cache, PR fetch coordination |
| [workspace-state.md](./workspace-state.md) | Run script, auto-iteration state, the Kanban column projection |
| [agent-runtime.md](./agent-runtime.md) | ACP runtime, provider sub-agents, child workspaces, quick actions |
| [integrations.md](./integrations.md) | GitHub, Linear, periodic tasks |

Keep these current. When behaviour changes, update the note in the same PR — a
stale rationale is worse than no rationale, because it is believed.

Related: `docs/design/` holds point-in-time design documents (including an
`archive/` of superseded ones). Those record what was decided at a moment;
these files record what is true now.
