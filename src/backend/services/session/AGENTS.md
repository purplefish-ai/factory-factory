# Session capsule

Agent sessions: the ACP runtimes for Claude Code and Codex, each session's
in-memory transcript, queue and runtime state, provider history, prompt
dispatch, delivery of PR updates and workspace mail into sessions, and
closed-session archives. The [services guide](../AGENTS.md) covers capsule
layout, boundaries and the module-map rule. `index.ts`, `modules.ts` and
`types.ts` are at the capsule root, modules are the directories under
`service/`, and paths that start with `src/` are from the repository root.

## Owns, and does not own

The capsule owns the Prisma models `AgentSession`, `AgentSessionLaunchOrigin`,
`ClosedSession`, `SessionLifecycleEvent` and `WorkspacePRDedicatedSession`,
written through the accessors in `resources/`, and the session logic in
`service/`. It does not own:

- Socket subscriptions, replay framing and delivery to viewers:
  `src/backend/routers/websocket/`, which the capsule publishes to through
  `sessionEventBus`.
- Wire schemas, the replay assembler and the closed-session reader schema:
  `src/shared/acp-protocol/`.
- The chat client: `src/client/features/chat/`. The closed-session archive view:
  `src/client/features/workspace/`.
- When a PR update is sent and to which conversation:
  `src/backend/orchestration/pull-requests/`.
- Workspace notification and mail records: the workspace capsule, through
  `workspaceNotificationService`.
- The update gate that admits session work:
  `src/backend/services/application-update-admission.service.ts`.
- The procedures over sessions and archives: `src/backend/trpc/session.trpc.ts`
  and `src/backend/trpc/closed-sessions.trpc.ts`.
- The MCP server that child workspace tools run in:
  `src/backend/mcp/workspace-mcp-server.ts`. The capsule only builds its spawn
  configuration (`child-workspace-mcp-server.ts`).

## Public surface

`index.ts` lists every public name: the ACP runtime (`acpRuntimeManager`), chat
commands and session loading, the composed singletons from
`service/composition/`, session data, PR and background delivery, dispatch,
event-owned sessions, lifecycle, logging, one-shot metadata inference,
`sessionDomainService` and the outbound `sessionEventBus`. Orchestration passes
capabilities in through the interfaces in `service/bridges/`.

## Invariants

- Permanent deletion of a session, directly or by its workspace's cascade, runs
  the `forget` of every participant registered with `sessionScope`.
  `service/lifecycle/session-scope.test.ts`, `session-scope-forget.test.ts`,
  `session-services.composition.test.ts`.

## Map

`modules.ts` describes each module under `service/` in one line and records
which modules import which. Modules with their own guide:

- [`service/data/`](service/data/AGENTS.md): provider history reads, their
  sharing and projection cache.
- [`service/archive/`](service/archive/AGENTS.md): closed-session archives and
  when a session may be closed.

`sessionScope` participants are registered in `service/composition/` and in
`registerSessionRuntimeParticipants` (`service/lifecycle/session-scope.ts`).

## Decisions

- [ACP session creation has its own deadline](../../../../docs/decisions/2026-11-13-acp-session-creation-has-its-own-deadline.md)
