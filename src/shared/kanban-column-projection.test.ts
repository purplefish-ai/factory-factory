import { describe, expect, it } from 'vitest';
import {
  KANBAN_COLUMN_BY_STATUS_REASON_CODE,
  kanbanColumnForStatusReason,
} from './kanban-column-projection';
import { WORKSPACE_STATUS_REASON_CODES } from './workspace-status-reason';

describe('kanbanColumnForStatusReason', () => {
  it('maps every status reason code', () => {
    for (const code of WORKSPACE_STATUS_REASON_CODES) {
      expect(KANBAN_COLUMN_BY_STATUS_REASON_CODE).toHaveProperty(code);
    }
  });

  it('puts every state where automation owns the next action in WORKING', () => {
    for (const code of [
      'SETTING_UP',
      'STARTING_SESSION',
      'AGENT_WORKING',
      'AUTO_ITERATING',
      'WAITING_FOR_CI',
      'FIXING_CI_FAILURES',
      'FIXING_REVIEW_COMMENTS',
      'FIXING_MERGE_CONFLICT',
      'CHECKING_PR',
    ] as const) {
      expect(kanbanColumnForStatusReason(code)).toBe('WORKING');
    }
  });

  it('puts every state where a human owns the next action in WAITING', () => {
    for (const code of [
      'NEEDS_PERMISSION',
      'NEEDS_PLAN_APPROVAL',
      'NEEDS_ANSWER',
      'SESSION_ERROR',
      'SETUP_FAILED',
      'MERGE_CONFLICT',
      'RATCHET_STALLED',
      'READY_TO_MERGE',
      'READY_FOR_REVIEW',
      'NO_SESSION_STARTED',
      'READY_FOR_NEXT_PROMPT',
    ] as const) {
      expect(kanbanColumnForStatusReason(code)).toBe('WAITING');
    }
  });

  it('puts terminal pull requests in DONE and archiving workspaces off the board', () => {
    expect(kanbanColumnForStatusReason('MERGED')).toBe('DONE');
    expect(kanbanColumnForStatusReason('PR_CLOSED')).toBe('DONE');
    expect(kanbanColumnForStatusReason('ARCHIVING')).toBeNull();
    expect(kanbanColumnForStatusReason('ARCHIVED')).toBeNull();
  });
});
