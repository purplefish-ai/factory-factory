import { KanbanColumn } from '@/shared/core';
import type { WorkspaceStatusReasonCode } from '@/shared/workspace-status-reason';

/**
 * The Kanban column is a projection of the status reason, not a second opinion.
 *
 * The column and the card label used to be derived independently from
 * overlapping inputs, which let them disagree: a dev server moved a card out of
 * "Ready to merge", and a conflicted PR read as "Checking PR". Typing this as a
 * total `Record` over the code union makes an unmapped code a compile error, so
 * the two cannot drift apart again.
 *
 * WAITING is positively asserted rather than inherited. A new code with no
 * obvious home belongs in WORKING: an unclassified workspace should read as
 * "something is happening" and get corrected, rather than quietly accumulating
 * in the column that is supposed to mean the user is blocking.
 */
export const KANBAN_COLUMN_BY_STATUS_REASON_CODE: Record<
  WorkspaceStatusReasonCode,
  KanbanColumn | null
> = {
  // Automation owns the next action.
  SETTING_UP: KanbanColumn.WORKING,
  STARTING_SESSION: KanbanColumn.WORKING,
  AGENT_WORKING: KanbanColumn.WORKING,
  AUTO_ITERATING: KanbanColumn.WORKING,
  WAITING_FOR_CI: KanbanColumn.WORKING,
  FIXING_CI_FAILURES: KanbanColumn.WORKING,
  FIXING_REVIEW_COMMENTS: KanbanColumn.WORKING,
  FIXING_MERGE_CONFLICT: KanbanColumn.WORKING,
  CHECKING_PR: KanbanColumn.WORKING,

  // A human owns the next action.
  NEEDS_PERMISSION: KanbanColumn.WAITING,
  NEEDS_PLAN_APPROVAL: KanbanColumn.WAITING,
  NEEDS_ANSWER: KanbanColumn.WAITING,
  SESSION_ERROR: KanbanColumn.WAITING,
  SETUP_FAILED: KanbanColumn.WAITING,
  MERGE_CONFLICT: KanbanColumn.WAITING,
  RATCHET_STALLED: KanbanColumn.WAITING,
  READY_TO_MERGE: KanbanColumn.WAITING,
  READY_FOR_REVIEW: KanbanColumn.WAITING,
  NO_SESSION_STARTED: KanbanColumn.WAITING,
  READY_FOR_NEXT_PROMPT: KanbanColumn.WAITING,

  // Finished.
  MERGED: KanbanColumn.DONE,
  PR_CLOSED: KanbanColumn.DONE,

  // Excluded from the board rather than placed in a column.
  ARCHIVING: null,
  ARCHIVED: null,
};

export function kanbanColumnForStatusReason(code: WorkspaceStatusReasonCode): KanbanColumn | null {
  return KANBAN_COLUMN_BY_STATUS_REASON_CODE[code];
}
