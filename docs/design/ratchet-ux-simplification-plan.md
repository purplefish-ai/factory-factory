# Ratchet UX Simplification Plan

## Goal

Simplify ratcheting language and controls so users can understand and act quickly:

- One clear per-workspace control (hammer button).
- Consistent visuals in workspace header, sidebar, and Kanban.
- Global setting treated as a default for new GitHub-issue workspaces (not a hard gate).
- Remove ambiguous glow/border effects that do not communicate clear state.

## Product Decisions (Confirmed)

1. Tertiary visual states for the hammer control:
   - Off: gray hammer.
   - On + idle: active hammer, dashed border visible but static.
   - On + processing: active hammer, dashed border with crawling-ants animation.
2. Default behavior scope:
   - Apply ratchet default only when creating a workspace from GitHub issues (for now).

## Current-State Findings

- Global ratchet is currently a hard backend gate (`ratchet.service.ts` exits early if disabled).
- Workspace header ratchet toggle is disabled when global setting is off.
- Tooltip language currently says “Ratcheting is disabled globally...”, which conflicts with intended behavior.
- Sidebar and Kanban ratchet indicators are currently separate and inconsistent (spinner-only treatment).
- Some ratchet activity indicators do not check `workspace.ratchetEnabled`, so disabled workspaces can still look active.
- `waiting-pulse` red glow is present and can be confused with ratchet signaling.
- `ratchet-active` is referenced in UI but no longer appears to be backed by active CSS.

## Implementation Plan

## Phase 1: Shared Ratchet UI Primitive

Create one reusable component for ratchet status + toggle behavior.

- Add a shared component (example: `src/components/workspace/ratchet-toggle-button.tsx`) with:
  - `enabled` (workspace-level switch),
  - `isProcessing` (active state machine work),
  - `onToggle`,
  - optional compact/full variants if needed.
- Standardize iconography to hammer (`lucide-react` Hammer).
- Implement three visual states:
  - Off: muted/gray icon and neutral border.
  - On idle: active icon + static dashed border.
  - On processing: active icon + animated dashed border (“ants”).
- Include accessibility:
  - `aria-pressed`,
  - keyboard activation,
  - tooltip text matching state/action.
- Include reduced-motion support:
  - keep dashed border but disable animation under `prefers-reduced-motion`.

## Phase 2: Behavioral Semantics (Global Default vs Hard Gate)

Shift global semantics from “master enable” to “default for new GitHub issue workspaces”.

- Backend ratchet loop:
  - Remove early return based on `userSettings.ratchetEnabled`.
  - Always evaluate workspaces with PRs.
  - Action execution remains strictly based on `workspace.ratchetEnabled`.
- Workspace-level toggle:
  - Keep always toggleable (no disable due to global setting).
  - Remove “disabled globally” UI copy.
- Admin naming/copy:
  - Rename “Enable Ratchet” to something like “Default ratcheting for new GitHub issue workspaces”.
  - Clarify this does not disable workspace-level toggling.

## Phase 3: Creation Defaults (GitHub Issues Only)

Apply default only in GitHub issue creation flow.

- Extend workspace create API input to accept optional `ratchetEnabled`.
- In GitHub issue creation path (`kanban/issue-card.tsx`):
  - Fetch user settings default.
  - Pass `ratchetEnabled` at create time.
- Leave manual create/resume flows unchanged for now.

## Phase 4: Consistency Across Surfaces

Use the same control and same interpretation everywhere ratchet appears.

- Workspace detail header:
  - Replace switch + wrench row with shared hammer control.
- Sidebar item:
  - Replace spinner-only ratchet indicator with shared control (or same visual token).
- Kanban card:
  - Replace spinner-only ratchet indicator with shared control (or same visual token).
- Ensure processing logic is consistent:
  - `isProcessing = workspace.ratchetEnabled && ratchetState in [CI_RUNNING, CI_FAILED, REVIEW_PENDING]`
  - Exclude `IDLE`, `READY`, `MERGED`.

## Phase 5: Remove Ambiguous Glow Language/Effects

- Remove `waiting-pulse` glow treatment from sidebar if retained only as visual noise.
- Delete stale comments that mention ratchet border spacing when not true.
- Remove any dead `ratchet-active` references or replace with new explicit class names tied to the shared component.

## Phase 6: Migration and Safety

Avoid surprising behavior for existing users.

- Add migration/backfill strategy (pick one before implementation):
  1. Conservative: if global ratchet is currently off, set all existing workspace `ratchetEnabled=false`.
  2. Non-destructive: do not mutate existing workspaces; only apply new semantics forward.
- Recommended: Conservative option to match prior user expectation that global off meant no automation.
- Add release note describing semantic change.

## Phase 7: Testing and Validation

### Backend

- Unit tests for ratchet loop behavior without global hard gate.
- Tests confirming actions only run when workspace `ratchetEnabled=true`.
- Tests for create mutation honoring optional `ratchetEnabled`.

### Frontend

- Component tests for tertiary visual states.
- Integration checks in:
  - workspace header,
  - sidebar,
  - Kanban card.
- Verify tooltips/action text for each state.
- Verify reduced-motion behavior.

### Manual QA

1. Global default ON, create from issue -> new workspace ratchet ON.
2. Global default OFF, create from issue -> new workspace ratchet OFF.
3. Toggle workspace ON/OFF regardless of global default.
4. Confirm processing animation only appears when ON + processing state.
5. Confirm no glow border ambiguity remains.

## File Targets (Expected)

- `src/client/routes/projects/workspaces/workspace-detail-header.tsx`
- `src/frontend/components/app-sidebar.tsx`
- `src/frontend/components/kanban/kanban-card.tsx`
- `src/frontend/components/kanban/issue-card.tsx`
- `src/client/routes/admin.tsx`
- `src/client/globals.css`
- `src/backend/services/ratchet.service.ts`
- `src/backend/trpc/workspace.trpc.ts`
- `src/backend/resource_accessors/workspace.accessor.ts`
- `docs/design/ratchet-visual-indicator.md` (follow-up update for historical accuracy)

## Risks

- Semantic drift between “on” and “processing” if state checks differ by surface.
- Unexpected automation for existing workspaces if migration/backfill is not handled.
- UI clutter if hammer control is too prominent in dense sidebar rows (may require compact variant).

## Rollout Order

1. Shared UI primitive + CSS tokens.
2. Backend semantic switch (remove hard global gate).
3. GitHub issue creation default wiring.
4. Replace header/sidebar/Kanban usages.
5. Remove glow/dead styles and update docs.
6. Run tests + QA matrix.
