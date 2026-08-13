# Codex Notification Ordering Design

## Problem

The Codex app-server RPC client reports notifications in wire order, but the ACP adapter launches each asynchronous notification handler independently. An `item/completed` handler can therefore overtake an earlier `item/started` handler while the latter awaits subagent bookkeeping or an ACP session update. The completed handler emits a terminal tool status, then the started handler resumes and emits `pending` or `in_progress` last. Factory Factory correctly treats that late non-terminal status as a newly open tool call and eventually synthesizes a timeout failure.

## Design

Serialize Codex app-server item notifications at their entry point in `CodexAppServerAcpAdapter`. Notifications for the same thread item are appended to a promise chain and processed only after the preceding notification for that item finishes. A failed handler is reported as adapter shape drift and absorbed at the chain boundary—even if reporting itself fails—so one malformed notification cannot permanently block later notifications.

Turn and thread notifications remain independent. This preserves the existing plan-approval flow, where `turn/completed` must be observed and deferred while the plan item handler awaits user permission. Server requests also remain on their existing path because they require independent responses. Tool timeout values and ACP terminalization rules remain unchanged.

## Alternatives Considered

- Mark `subAgentActivity` complete on `item/started`: hides the observed symptom but reports completion before the provider does and does not fix reasoning or collaboration-tool races.
- Terminalize open tools at `turn/completed`: useful only after a turn ends, so it cannot protect hour-long multi-agent turns.
- Increase the timeout: delays the false failure without correcting event order.

## Testing

Add an adapter regression that deliberately blocks the first subagent session update, delivers `item/started` and `item/completed` without awaiting the first handler, then releases the block. The observable ACP statuses must remain `pending`, `in_progress`, `completed`; the old implementation produces `pending`, `completed`, `in_progress`. Add queue tests proving a rejected handler and a throwing error reporter cannot poison later notifications for the same item.

Run the focused adapter tests, then the repository-required formatting, type, test, and guardrail commands.
