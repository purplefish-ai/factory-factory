# Child-Workspace Notification Delivery Design

## Goal

Extract live child-workspace notification delivery from the workspace tRPC router into a reusable, transport-neutral application use case while preserving persistence-first fallback, queue deduplication, UI deltas, and dispatch behavior in both directions.

## Approaches Considered

1. Add a focused orchestration use case and compose a dedicated child-workspace router with tRPC's public `mergeRouters` API. This is the selected approach because delivery coordinates the workspace and session capsules without creating a service dependency cycle, and flat composition preserves all existing `workspace.*` procedure paths.
2. Put delivery in the workspace service capsule. This would place notification ownership next to persistence, but live delivery requires session services and would introduce a forbidden workspace-to-session dependency while session already depends on workspace.
3. Put delivery in the session service capsule. The current registry permits session-to-workspace access, but parent/child direction and source metadata are workspace application concepts, so this would make the session capsule own policy unrelated to session runtime.

## Architecture

`src/backend/orchestration/workspace-notification-delivery.orchestrator.ts` will export `deliverWorkspaceNotification`. Its input names the notification direction, target workspace, source workspace metadata, message, and a callback that constructs the direction-specific `AgentMessage` rendered by the UI. The use case will own the shared persistence-first and live-delivery sequence.

The use case will depend only on the public workspace and session service barrels. It will persist a `WorkspaceNotification` before looking for a live session, select the most recent `RUNNING` or `IDLE` session, deduplicate with the deterministic workspace-notification message ID, enqueue the agent-facing user message, append and emit the supplied UI event, and ask the chat handler to dispatch the next queued message. Missing active sessions and enqueue rejection will leave the durable notification pending and return `{ delivered: false }`; an already queued notification will return `{ delivered: true }` without duplicating the UI event or dispatch.

`src/backend/trpc/workspace/children.trpc.ts` will own all child-workspace transport procedures: create, list, parent lookup, bidirectional messaging, archive, and pending-count queries. It will retain tRPC input validation and relationship-specific transport errors. The messaging mutations will resolve and validate workspace relationships, build source metadata and the direction-specific UI event callback, then delegate the workflow to `deliverWorkspaceNotification`.

`src/backend/trpc/workspace.trpc.ts` will retain the main workspace procedures and export a router assembled with the public `mergeRouters` helper. It will merge the core workspace router, the new child-workspace router, and the existing files, Git, IDE, initialization, and run-script routers without reading `_def.procedures`. Existing client and MCP paths such as `workspace.sendMessageToParent` will remain flat and unchanged.

## Data Flow

For child-to-parent delivery, the child router validates that the child exists and has a parent, then passes the parent as the target and child identity/project details as the source. Its UI callback creates a `child_workspace_update` event.

For parent-to-child delivery, the child router validates that the child belongs to the specified parent, loads the parent metadata, then passes the child as the target and parent identity/project details as the source. Its UI callback creates a `parent_workspace_update` event.

Both routes then follow one sequence:

1. Create the durable notification row.
2. Find the latest active target session.
3. Return pending if no session is active.
4. Return delivered if startup delivery already queued the same notification ID.
5. Enqueue the deterministic notification message.
6. Return pending if enqueue rejects the message.
7. Append and emit the direction-specific UI event.
8. Dispatch the next queued message and return delivered.

The existing message handler remains responsible for marking the notification delivered after the queued user message is committed. The extraction does not change that settlement point.

## Error Handling and Compatibility

The dedicated child router preserves the existing `NOT_FOUND`, `BAD_REQUEST`, and `FORBIDDEN` tRPC errors for invalid workspace relationships. The application use case contains no tRPC types. Database and unexpected dispatch errors continue to propagate, while the expected absence of an active session and queue rejection remain non-throwing fallback outcomes.

The live enqueue warning will include direction, notification ID, session ID, and the queue error. No durable notification is deleted or marked delivered by the new use case when enqueue fails.

## Testing

A focused orchestrator test will exercise the shared implementation with both directions. Coverage will prove notification persistence precedes live enqueue; the latest active session is chosen; no-active-session fallback leaves the row queued; an already queued message deduplicates without a second UI event; enqueue failure leaves the row pending; successful delivery appends and emits the exact direction-specific UI event; and dispatch occurs only after enqueue and UI publication.

A dedicated child-router test will prove relationship validation and direction-specific delegation inputs for both mutations while retaining coverage for the other extracted procedures. The main workspace router test will no longer mock or test child delivery internals. Router-composition coverage and a source scan will ensure `_def.procedures` is absent and all existing flat procedure names remain callable.

Full verification will run type checking, Biome fixes, the complete Vitest suite, and the production build.

## Edge Cases

- Session lists may contain stopped sessions after a newer active session; only the most recent `RUNNING` or `IDLE` entry is selected.
- Session startup may queue the notification between persistence and the explicit live-delivery check; deterministic message IDs prevent duplicate enqueue and UI cards.
- Queue rejection after persistence must not dispatch or publish a UI event, so the next session startup can retry the pending row.
- A missing parent, missing child, or mismatched relationship must fail before notification creation.
- A parent metadata lookup that unexpectedly returns no record returns `{ delivered: false }`, matching the existing persistence helper's missing-workspace fallback.
- The extraction must keep public tRPC procedure paths flat for the client and child-workspace MCP server.
