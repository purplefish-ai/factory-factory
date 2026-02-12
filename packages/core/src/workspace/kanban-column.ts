import { KanbanColumn, PRState, WorkspaceStatus } from '../types/enums.js';

export interface KanbanStateInput {
  lifecycle: WorkspaceStatus;
  isWorking: boolean;
  prState: PRState;
  hasHadSessions: boolean;
}

/**
 * Pure function to compute kanban column from workspace state.
 * This is the core derivation logic for the kanban board.
 *
 * Simplified 3-column model:
 * - WORKING: Initializing states (NEW/PROVISIONING/FAILED) or actively working
 * - WAITING: Idle workspaces with hasHadSessions=true (includes PR states)
 * - DONE: PR merged
 *
 * Note: Workspaces with hasHadSessions=false AND status=READY are hidden from view.
 * Archived workspaces retain their pre-archive cachedKanbanColumn and are hidden
 * unless "Show Archived" toggle is enabled.
 *
 * Returns null for workspaces that should be hidden (READY + no sessions).
 */
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn | null {
  const { lifecycle, isWorking, prState, hasHadSessions } = input;

  // Archived workspaces: return null - they use cachedKanbanColumn from before archiving
  // The caller should handle archived workspaces separately
  if (lifecycle === WorkspaceStatus.ARCHIVED) {
    return null;
  }

  // WORKING: Initializing states (not ready for work yet) or actively working
  if (
    lifecycle === WorkspaceStatus.NEW ||
    lifecycle === WorkspaceStatus.PROVISIONING ||
    lifecycle === WorkspaceStatus.FAILED ||
    isWorking
  ) {
    return KanbanColumn.WORKING;
  }

  // From here, lifecycle === READY and not working

  // DONE: PR merged
  if (prState === PRState.MERGED) {
    return KanbanColumn.DONE;
  }

  // Hide workspaces that never had sessions (old BACKLOG items)
  // These are filtered out from the kanban view
  if (!hasHadSessions) {
    return null;
  }

  // WAITING: Everything else - idle workspaces with sessions
  // (includes PR states: NONE, DRAFT, OPEN, CHANGES_REQUESTED, APPROVED, CLOSED)
  return KanbanColumn.WAITING;
}
