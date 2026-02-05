# Ratchet Visual Indicator - Design Document

## Overview

This feature adds a visual indicator to workspace cards and sidebar items when the ratchet system is actively processing a workspace. The indicator is an animated black and yellow "marching ants" border that draws attention to workspaces where automated PR progression is occurring.

## Problem Statement

When the ratchet system is active (fixing CI failures, resolving merge conflicts, addressing review comments, etc.), users have no visual indication that automated work is in progress. This can lead to confusion about the current state of a workspace.

## Solution

Add an animated border effect to workspace UI elements when `ratchetState` is not `IDLE`. The animation uses a black and yellow striped pattern that moves horizontally, evoking a "caution tape" aesthetic that clearly signals automated activity.

## Architecture

### Data Flow

```mermaid
flowchart TD
    subgraph Database
        WS[(Workspace Table)]
    end

    subgraph Backend
        WQS[WorkspaceQueryService]
        WS -->|ratchetState| WQS
    end

    subgraph "API Layer"
        TRPC[tRPC Endpoints]
        WQS -->|getProjectSummaryState| TRPC
        WQS -->|listWithKanbanState| TRPC
    end

    subgraph Frontend
        KC[KanbanCard]
        SWI[SortableWorkspaceItem]
        TRPC -->|workspace.ratchetState| KC
        TRPC -->|workspace.ratchetState| SWI
    end

    subgraph CSS
        RA[.ratchet-active class]
        KC -->|applies class| RA
        SWI -->|applies class| RA
    end
```

### Component Hierarchy

```mermaid
flowchart TB
    subgraph "Kanban Board View"
        KB[KanbanBoard]
        KC1[KanbanColumn]
        KCard[KanbanCard]
        KB --> KC1
        KC1 --> KCard
        KCard -->|"ratchetState !== 'IDLE'"| RA1[ratchet-active]
    end

    subgraph "Sidebar View"
        AS[AppSidebar]
        SWI[SortableWorkspaceItem]
        SMB[SidebarMenuButton]
        AS --> SWI
        SWI --> SMB
        SMB -->|"ratchetState !== 'IDLE'"| RA2[ratchet-active]
    end
```

### CSS Animation Architecture

```mermaid
flowchart LR
    subgraph ".ratchet-active Element"
        direction TB
        BEFORE["::before<br/>(z-index: 0)<br/>Animated striped border"]
        AFTER["::after<br/>(z-index: 1)<br/>Solid background cover"]
        CONTENT["Content<br/>(z-index: 2)<br/>Card/Button content"]
    end

    BEFORE -->|"inset: -2px"| BORDER[2px animated border visible]
    AFTER -->|"inset: 0"| COVER[Covers interior]
    CONTENT -->|"position: relative"| VISIBLE[Content on top]
```

## Ratchet State Machine

The animation appears for all non-IDLE states:

```mermaid
stateDiagram-v2
    [*] --> IDLE: No PR / Ratchet disabled

    IDLE --> CI_RUNNING: PR opened / CI triggered

    CI_RUNNING --> CI_FAILED: CI fails
    CI_RUNNING --> MERGE_CONFLICT: Conflicts detected
    CI_RUNNING --> REVIEW_PENDING: Reviews pending
    CI_RUNNING --> READY: All checks pass

    CI_FAILED --> CI_RUNNING: Fix pushed
    MERGE_CONFLICT --> CI_RUNNING: Conflicts resolved
    REVIEW_PENDING --> CI_RUNNING: Reviews addressed

    READY --> MERGED: Auto-merge or manual merge
    MERGED --> IDLE: Cleanup

    note right of IDLE: No animation
    note right of CI_RUNNING: Animation active
    note right of CI_FAILED: Animation active
    note right of MERGE_CONFLICT: Animation active
    note right of REVIEW_PENDING: Animation active
    note right of READY: Animation active
    note right of MERGED: Animation active
```

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/backend/services/workspace-query.service.ts` | Modified | Added `ratchetState` to `getProjectSummaryState` response |
| `src/frontend/components/use-workspace-list-state.ts` | Modified | Added `ratchetState` to `ServerWorkspace` interface |
| `src/frontend/components/kanban/kanban-card.tsx` | Modified | Apply `ratchet-active` class when ratchet is active |
| `src/frontend/components/app-sidebar.tsx` | Modified | Apply `ratchet-active` class to sidebar items |
| `src/client/globals.css` | Modified | Added `.ratchet-active` CSS animation |
| `src/frontend/components/kanban/kanban-card.stories.tsx` | Modified | Added Storybook stories for ratchet states |

## Implementation Details

### Backend Changes

The `getProjectSummaryState` method now includes `ratchetState` in the workspace response:

```typescript
return {
  id: w.id,
  name: w.name,
  // ... other fields
  ratchetState: w.ratchetState,  // NEW
};
```

### Frontend Logic

Both `KanbanCard` and `SortableWorkspaceItem` use the same logic:

```typescript
const isRatchetActive = workspace.ratchetState && workspace.ratchetState !== 'IDLE';
```

### CSS Animation

The animation uses a layered pseudo-element approach:

1. **`::before`** - Creates the animated striped background, positioned 2px outside the element
2. **`::after`** - Covers the interior with the appropriate background color
3. **Direct children** - Elevated to z-index 2 to appear above both pseudo-elements

```css
.ratchet-active::before {
  background: repeating-linear-gradient(
    90deg,
    #000 0px, #000 8px,      /* Black stripe */
    #fbbf24 8px, #fbbf24 16px /* Yellow stripe */
  );
  animation: ratchet-march 0.4s linear infinite;
}
```

The sidebar uses a different background color via CSS specificity:

```css
[data-sidebar] .ratchet-active::after {
  background: var(--sidebar);
}
```

## Visual Appearance

```
┌─────────────────────────────────────┐
│ ████░░░░████░░░░████░░░░████░░░░████│  ← Animated border (moves right)
│ ░                                 ░ │
│ ░   Workspace Name                ░ │
│ ░   feature/branch-name           ░ │
│ ░   #42 PR                        ░ │
│ ░                                 ░ │
│ ████░░░░████░░░░████░░░░████░░░░████│
└─────────────────────────────────────┘
  ████ = Black (#000)
  ░░░░ = Yellow (#fbbf24)
```

## Testing

### Storybook Stories Added

- `RatchetActive` - CI_FAILED state
- `RatchetReviewPending` - REVIEW_PENDING state
- `RatchetReady` - READY state

### Manual Testing

1. Enable ratchet for a workspace with an open PR
2. Trigger a CI failure
3. Verify animation appears in both Kanban and sidebar
4. Verify animation stops when ratchet returns to IDLE

## Future Considerations

- **Different animations per state**: Could use different colors or speeds for different ratchet states (e.g., red for CI_FAILED, orange for REVIEW_PENDING)
- **Reduced motion**: Add `prefers-reduced-motion` media query support for accessibility
- **State-specific tooltips**: Show tooltip explaining what the ratchet is currently doing
