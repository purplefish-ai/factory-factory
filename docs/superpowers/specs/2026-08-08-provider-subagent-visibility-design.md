# Provider-Initiated Sub-Agent Visibility Design

## Goal

Make provider-initiated sub-agents visible and inspectable in Factory Factory
without turning them into Factory Factory sessions or child workspaces. The first
implementation targets Codex, remains read-only, and uses an ACP boundary that
future providers such as Claude can implement without client changes.

## User Experience

Rename the workspace right-panel **Children** tab to **Agents**. The tab contains
two deliberately separate sections:

1. **Sub-agents** shows provider-initiated agents belonging to the currently
   selected parent session. Active sub-agents are expanded and visible. Finished
   sub-agents are hidden one layer beneath a collapsed `Completed · N` row, but
   remain selectable and inspectable.
2. **Child workspaces** retains the existing workspace-wide child-workspace list
   and behavior. These entries remain independent workspaces with their existing
   navigation and lifecycle controls.

Each sub-agent row shows a provider-supplied or fallback name, normalized status,
elapsed time, and a short latest-activity or result preview. Active rows sort by
creation time, oldest first, to keep the launch order stable; completed rows sort
by most recent completion or update time. The normalized lifecycle states are:

- `starting`, `running`, and `waiting` in the active group;
- `completed`, `failed`, `cancelled`, and `interrupted` in the completed group.

Selecting a sub-agent drills into a read-only transcript inside the current
parent session view. The parent session tab stays selected. A breadcrumb such as
`Parent session > Sub-agent name`, a `Read only` badge, and a Back action replace
the normal session header and composer. Returning restores the parent transcript
and its scroll position. Changing the selected parent session or workspace exits
the drill-in state.

The transcript reuses the existing chat renderers for assistant text, reasoning,
commands, file changes, tool calls, and results. No composer, permission prompt,
stop control, steering control, or other mutation is available in the first
version. Users can ask the parent agent to steer or stop a sub-agent when the
provider supports that behavior.

Completed sub-agents remain inspectable after an application restart for as long
as the provider retains the parent session and its child-thread logs. Factory
Factory does not promise retention beyond the provider's own retention policy.

## Prior Art and Protocol Findings

The selected interaction follows current Codex behavior: Codex exposes read-only
Active and Done lists and allows an individual sub-agent thread to be opened for
inspection. Zed provides a Threads Sidebar for native and ACP agents and chose a
sidebar, rather than agent tabs, for parallel agent threads. Zed's documented
parallel threads are primarily user-created top-level sessions, however, rather
than provider-initiated child threads.

The current `agentclientprotocol/codex-acp` adapter represents Codex sub-agent
launches as standard ACP tool calls and attaches Codex thread identity and
activity under namespaced `_meta.codex.subagent` metadata. This establishes a
useful ecosystem pattern for live lifecycle reporting, but stable ACP does not
yet define a provider-neutral child-thread browsing contract.

Codex app-server supplies the missing read side: experimental parent and ancestor
filters on `thread/list`, stored-thread reads through `thread/read`, paginated
turn and item reads, and runtime thread statuses. Factory Factory's Codex adapter
already opts into the experimental app-server API. Claude's ACP adapter already
preserves sub-agent parent-tool attribution, which supplies correlation but not
yet the same browseable transcript capability.

Sources:

- [Codex sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex app-server thread APIs](https://learn.chatgpt.com/docs/app-server)
- [Zed agent threads](https://zed.dev/docs/ai/agents)
- [Zed parallel-agent sidebar decision](https://github.com/zed-industries/zed/discussions/42381)
- [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Claude ACP adapter changelog](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/CHANGELOG.md)

## Approaches Considered

### 1. Standard ACP activity plus a narrow browse extension

This is the selected approach. Standard ACP tool calls carry live launch and
activity state, while a namespaced ACP extension supplies capability discovery,
parent-scoped listing, read-only transcript pagination, and invalidation. It
matches current adapter practice without pretending stable ACP has a nested
session abstraction that it does not yet provide.

### 2. Standard ACP tool calls only

This would display launch and completion activity with no custom protocol, but
it could not reliably reconstruct a child transcript, reconcile missed events,
or recover completed sub-agents after restart. It does not meet the inspection
requirement.

### 3. Call Codex app-server directly from the session backend

This would make the Codex implementation quick, but it would leak Codex method
names, thread shapes, and experimental behavior past the ACP adapter. Adding
Claude would then require provider branching across the backend and client.

### 4. Persist normalized sub-agent sessions in Prisma

This would provide application-owned retention, but it would duplicate provider
history, introduce reconciliation and partial-write problems, and blur the line
between provider threads and Factory Factory sessions. Provider logs are already
the source of truth, so this version deliberately avoids new persistence.

### 5. Expose child threads through generic ACP session list/load APIs

Generic session browsing does not encode the parent-child, provider-initiated,
read-only semantics required here. Treating sub-agents as ordinary top-level
sessions would also make them appear editable and would conflate them with the
user-created sessions already represented by Factory Factory tabs.

## ACP Extension Contract

All Factory Factory extension names and metadata keys use the public product
namespace `factoryfactory.ai`.

During ACP initialization, an adapter that supports inspection advertises:

```json
{
  "agentCapabilities": {
    "_meta": {
      "factoryfactory.ai/subagents": {
        "version": 1,
        "list": true,
        "read": true,
        "notifications": true
      }
    }
  }
}
```

Adapters annotate the standard ACP tool call representing a provider-initiated
sub-agent with provider-neutral metadata:

```json
{
  "_meta": {
    "factoryfactory.ai/subagent": {
      "id": "provider-stable-child-id",
      "parentSessionId": "acp-parent-session-id"
    }
  }
}
```

The metadata supplements the standard ACP tool-call status and content. It does
not replace the ordinary `tool_call` and `tool_call_update` stream, so clients
that do not know the extension still render useful agent activity.

The browse methods are:

- `factoryfactory.ai/subagents/list`
- `factoryfactory.ai/subagents/read`

`list` accepts `{ sessionId, cursor?, limit? }`, where `sessionId` is the parent
ACP session ID. It returns `{ subagents, nextCursor }`. The summaries represent
direct children only, never all descendants:

```ts
type SubagentSummary = {
  id: string;
  name: string | null;
  status:
    | "starting"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  latestActivity: string | null;
  resultPreview: string | null;
};
```

`read` accepts `{ sessionId, subagentId, cursor?, limit? }` and returns
`{ projectionBoundary: 'turn', updates, nextCursor }`. The updates are
chronologically ordered ACP session updates, and every page contains only whole
provider turns. The required boundary marker is validated at the ACP boundary so
the client can safely cache projection per page. Reusing ACP update shapes lets
the existing transcript normalization and renderers process provider history
without a second provider-specific chat model.

The adapter emits `factoryfactory.ai/subagents/changed` when a child is created,
its activity or status changes, or it reaches a terminal outcome. The
notification contains only the parent session ID, sub-agent ID, and change kind;
consumers re-read authoritative summaries or transcript pages rather than
constructing provider state from deltas.

Capability detection, method inputs, results, metadata, and notifications are
validated with Zod at the ACP boundary. Unknown future fields remain tolerable,
while an unsupported version disables browsing instead of guessing at shapes.

## Codex Adapter Mapping

The internal Codex ACP adapter owns every Codex-specific operation and shape:

- collaboration and sub-agent activity items become standard ACP tool calls and
  updates with `factoryfactory.ai/subagent` metadata;
- `factoryfactory.ai/subagents/list` maps to Codex `thread/list` with the
  experimental `parentThreadId` filter;
- `factoryfactory.ai/subagents/read` maps to `thread/read` initially and can use
  paginated turn or item methods when the transcript exceeds one page;
- Codex thread names, runtime statuses, source kinds, turns, and items normalize
  into the extension DTOs and ordinary ACP session updates;
- Codex sub-agent activity and `thread/status/changed` notifications produce the
  provider-neutral invalidation notification.

Codex thread IDs never leave the adapter except as opaque sub-agent IDs. No
React component, tRPC procedure, or session service branches on `CODEX` to make
the feature work.

## Backend Ownership and Data Flow

The session service capsule owns the application-facing sub-agent operations
because sub-agents belong to a parent session and use that session's live ACP
connection. It exposes provider-neutral list and read methods through its public
barrel. The tRPC layer validates client input and delegates to those methods; it
does not interpret provider metadata.

The flow is:

1. The active adapter reports browse capability during ACP initialization.
2. Standard ACP tool-call updates make live sub-agent activity visible in the
   parent transcript and invalidate the parent session's sub-agent list.
3. Opening the Agents tab for a selected session requests the first summary page.
4. The session service invokes the adapter extension over the existing ACP
   connection and returns normalized summaries.
5. Selecting a row requests the first read-only transcript page.
6. The existing chat projection renders the returned ACP session updates.
7. A `subagents/changed` notification invalidates the summary and, when open,
   transcript queries. The refreshed provider read repairs missed events.
8. Reconnecting or reloading a parent session repeats `list`, rebuilding the UI
   from provider history without database reconciliation.

Factory Factory caches only normal React Query and live session state. It adds no
Prisma model, export field, snapshot field, or backup behavior for sub-agents.

## Client Composition and State

The right-panel tab becomes an Agents composition surface rather than widening
the child-workspace feature's public API. An Agents panel composes a new
session-scoped sub-agent section with the existing workspace-scoped child
workspace section.

The selected parent session ID is part of the sub-agent query key. Selecting a
different session therefore shows only that session's provider children, while
the child-workspace section remains unchanged. Providers without the browse
capability omit the Sub-agents section entirely; there is no provider-name check.

Drill-in selection is ephemeral UI state containing the parent session ID and
sub-agent ID. It does not create a session tab, route to another workspace, or
mutate the selected top-level session. The parent transcript's scroll state is
preserved while the read-only child transcript is shown.

The Agents tab loads sub-agent summaries only when relevant to the visible panel
and selected session. Transcript pages load on demand. Live invalidation replaces
polling; reconnect reconciliation provides the safety net.

## Authorization and Trust Boundary

Every read request includes both parent session ID and sub-agent ID. The session
service resolves the ACP connection for that exact Factory Factory session. The
adapter verifies that the requested child belongs directly to the supplied
parent before reading its provider log. A caller cannot supply an arbitrary
provider thread ID and use the extension as a general thread reader.

Transcript content has the same workspace visibility as its parent session. The
feature introduces no new cross-workspace access and does not expose provider
filesystem paths, credentials, raw configuration, or unrelated thread metadata.

## Error Handling and Compatibility

- If initialization does not advertise a compatible browsing capability, the
  Sub-agents section is absent and existing session and child-workspace behavior
  is unchanged.
- If listing fails after capability discovery, the section shows a contained
  unavailable state with Retry; the parent session remains usable.
- If a child summary exists but its log is missing, corrupt, or outside provider
  retention, the row remains visible and the drill-in shows `Transcript
  unavailable` with the normalized outcome and preview when available.
- If an active child disappears during reconnect, the authoritative provider
  list wins. When the provider reports a terminal status, the row moves to the
  completed group; Factory Factory does not synthesize success.
- Unknown provider statuses normalize to the safest supported state and retain a
  diagnostic log. Unknown terminal states must not appear active indefinitely.
- Invalid cursors, malformed extension responses, parent-child mismatches, and
  unsupported extension versions fail as typed application errors rather than
  crashing or partially replacing the parent transcript.
- Standard ACP tool calls continue to render even when browse extension parsing
  fails, preserving baseline visibility and forward compatibility.

## Testing and Visual Verification

Adapter contract tests will cover Codex collaboration and sub-agent activity
mapping, metadata attachment, lifecycle normalization, parent-filtered listing,
read pagination, transcript conversion, invalidation notifications, unknown
fields, malformed responses, and unsupported app-server methods.

Session service and transport tests will cover capability detection, unsupported
providers, exact parent-session connection selection, direct-child authorization,
pagination, reconnect reconciliation, typed errors, and the absence of provider
branches outside the adapter.

React tests will cover session scoping, active and completed grouping, completed
collapse state, sorting, provider capability gating, loading and unavailable
states, drill-in and Back behavior, parent scroll restoration, composer removal,
live invalidation, and leaving drill-in when the session or workspace changes.

Storybook stories will exercise empty, active-only, mixed, completed-collapsed,
loading, list-error, transcript-error, and unsupported-provider states in the
right panel and read-only transcript view. Visual review must confirm that the
Agents panel remains legible at the existing narrow right-panel widths.

An end-to-end Codex scenario will launch a provider sub-agent, observe its live
row and parent tool call, open its updating transcript, observe its terminal
outcome, collapse and reopen the completed group, restart the application, load
the parent session, and inspect the completed transcript again.

## Rollout and Future Providers

Codex ships first. Capability detection is the rollout gate, so adapters that do
not implement the extension require no feature flag and show no incomplete UI.
The first release remains read-only even if a provider supports stop or steering
operations.

Claude support is a later adapter task. Its implementation may use parent tool
attribution for correlation and must advertise browsing only when it can return
durable, parent-authorized transcript history. Other providers follow the same
rule. If ACP later standardizes provider-initiated child-thread discovery and
reading, the adapter contract can migrate behind the same session service and UI
without changing the user experience.

## Out of Scope

- Creating, steering, messaging, stopping, closing, or archiving provider
  sub-agents from the UI.
- Showing all workspace sub-agents regardless of selected parent session.
- Representing provider sub-agents as Factory Factory sessions, workspaces, or
  child workspaces.
- Persisting provider transcripts or lifecycle state in Factory Factory's
  database, exports, snapshots, or backups.
- Nested visualization beyond direct children in the first release, even when a
  provider exposes deeper descendants.
- Claude or other provider implementation in the first Codex-focused release.
