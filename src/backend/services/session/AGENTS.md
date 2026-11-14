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
written through the accessors in `resources/` (and `AgentSession` by backup
import), and the session logic in `service/`. It does not own:

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

## Public surface

`index.ts` names every public export, in groups: the ACP runtime, chat,
composition singletons, configuration, session data, delivery, dispatch,
event-owned sessions and the interceptor bridge, lifecycle, logging, metadata,
prompts, providers, the store, `sessionEventBus` and voice narration.
Orchestration passes capabilities in through `service/bridges/`.

## Invariants

- Permanent deletion of a session, directly or by its workspace's cascade, runs
  the `forget` of every participant registered with `sessionScope`.
  `service/lifecycle/session-scope.test.ts`, `session-scope-forget.test.ts`,
  `session-services.composition.test.ts`, `session-data.service.test.ts`,
  `session-config-deletion.test.ts`, `session-workflow-finalizer.test.ts`,
  `src/backend/trpc/workspace.router.test.ts`.

## Map

Modules are the directories under `service/`. `modules.ts` describes each in one
line, and a module directory may hold its own `AGENTS.md`; read it before
editing there.

`pnpm check:service-registry` holds `modules.ts` to the code. A production file
sits in a module directory, never directly in `service/`. A new module directory
needs an entry with a description. A module's `dependsOn` is the sorted list of
the sibling modules its production files import, re-export or import types from,
and no import may close a cycle. Production code outside the capsule imports
only `index.ts` (`pnpm deps:check`; see the services guide).

`sessionScope` participants are registered in `service/composition/` and in
`registerSessionRuntimeParticipants` (`service/lifecycle/session-scope.ts`).
