# Sub-Agent Transcript Tabs Design

## Goal

Replace the route-local sub-agent transcript drill-in with a normal, closable
main-view tab. Sub-agent transcripts should remain easy to revisit while users
switch among chats, files, and other workspace content.

## User Experience

Selecting a provider sub-agent in the Agents panel opens a main-view tab beside
the existing file, diff, screenshot, and history tabs. The tab shows the
sub-agent's provider-supplied name, or the existing fallback name, with a robot
icon and a close button. Opening the same sub-agent again focuses its existing
tab instead of creating a duplicate. Different sub-agents may be open at the
same time.

Sub-agent tabs persist with the other workspace tabs. They remain open while the
user changes the selected parent chat, navigates among workspace content, or
reloads the application. Tab identity is the pair of parent session ID and
sub-agent ID, because provider child IDs are scoped to their parent session.

The robot icon communicates the sub-agent's last-known lifecycle state:

- `starting` and `running`: blue, with a gentle pulse;
- `waiting`: amber;
- `completed`: green;
- `failed`: red;
- `cancelled` and `interrupted`: muted.

Live sub-agent invalidations refresh the transcript summary and update the tab
icon. A restored tab initially uses its persisted status, then replaces it with
the refreshed provider status when available.

The transcript fills the content area like a file view. Remove the current Back
button, parent/sub-agent breadcrumb, `Read only` pill, and status pill. The lack
of a composer continues to make the transcript read-only. Loading, empty,
pagination, retry, unavailable, and message-rendering behavior remain unchanged.

## Selected Approach

Add `subagent` as a first-class `MainViewTab` type in the workspace panel model.
This reuses the existing tab bar's selection, close, neighboring-tab fallback,
horizontal scrolling, and local-storage persistence behavior.

The alternatives were rejected:

- Drawing a tab while keeping route-local drill-in state would duplicate tab
  lifecycle behavior and would not naturally persist with other workspace tabs.
- Encoding sub-agents as an existing file or closed-session tab type would mix
  unrelated concepts and make restoration and rendering brittle.

## Tab Model

A sub-agent tab stores the data needed to render before and after reload:

```ts
interface MainViewTab {
  id: string;
  type: 'subagent';
  label: string;
  parentSessionId: string;
  subagentId: string;
  subagentStatus: SubagentStatus;
}
```

The actual shared union will continue to represent the existing tab types and
their fields. The persisted Zod schema validates the new type and requires all
three sub-agent fields. Tabs with incomplete or invalid persisted data are
discarded through the panel's existing safe fallback behavior.

The tab ID is deterministic from the parent session ID and sub-agent ID. The
panel exposes an explicit sub-agent opening operation, or an equivalent typed
input, so callers do not overload the existing path argument with structured
metadata. Opening updates the stored label and status from the newest selection
and activates the tab.

## Component Responsibilities and Data Flow

`WorkspaceDetailView` continues to validate that a selection belongs to the
currently selected session and closes the mobile right-panel sheet after a
selection. It delegates opening to the workspace panel instead of owning
sub-agent drill-in state. The route-local scroll bookkeeping and Back handler
are removed; chat scroll is already preserved because `MainViewContent` keeps
chat mounted while non-chat tabs are active.

`MainViewTabBar` renders sub-agent tabs with the shared `TabButton`. A dedicated
sub-agent tab item chooses the robot icon color and animation from the persisted
status. Sub-agent tabs appear in the same closable group as file-like tabs, after
the separator from permanent chat/session tabs.

`MainViewContent` recognizes the active sub-agent tab, reconstructs a
`SubagentSelection` from its stored metadata, and renders
`SubagentTranscriptView`. The transcript view already re-reads the authoritative
summary and transcript using the parent session ID and sub-agent ID.

When `SubagentTranscriptView` receives a fresher summary after initial load or a
live invalidation, it reports the current name and status back to the panel. The
panel updates only the matching persisted tab. This keeps the tab label and icon
current without duplicating the provider query in the tab bar.

`SubagentTranscriptContent` becomes transcript-only. It retains the message
viewport and all state renderers but no longer accepts or renders `onBack`.

## Error and Restoration Behavior

Persistence does not imply Factory Factory owns the provider transcript. If the
provider no longer retains the parent session or child thread, the restored tab
shows the existing transcript-unavailable state and Retry action. The user can
close it normally. A stale last-known status remains a visual hint until a
successful summary refresh; transcript errors do not delete the tab.

Switching or closing a parent Factory Factory chat does not automatically close
its sub-agent tabs. This matches the requested file-tab behavior and preserves a
useful transcript even when the parent is not the selected chat.

## Testing

Tests will cover:

- opening a sub-agent creates and activates a closable tab;
- reopening the same parent/sub-agent pair focuses and refreshes one tab;
- children with the same opaque ID under different parents remain distinct;
- selecting chats and other content leaves sub-agent tabs open;
- close behavior selects the neighboring tab through the existing panel rules;
- valid sub-agent tabs persist and restore, while invalid stored entries fall
  back safely;
- each lifecycle state maps to the expected robot color and running animation;
- refreshed provider summaries update the persisted label and icon status;
- the transcript renders without the former Back/breadcrumb/status header;
- mobile selection still closes the right-panel sheet;
- existing loading, pagination, invalidation, unavailable, and scroll behavior
  remains covered by the sub-agent transcript tests.

Run the focused Vitest suites during the red-green cycle, followed by the
repository's typecheck and standard guardrails.

## Scope

This change is client-only. It does not alter the ACP browse contract, tRPC
procedures, provider transcript retention, Agents panel grouping, or read-only
semantics. It does not add tab reordering, pinning, or mutation controls for
sub-agents.
