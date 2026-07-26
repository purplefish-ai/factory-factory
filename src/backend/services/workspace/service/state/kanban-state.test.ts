import { describe, expect, it } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import { computeKanbanColumn, type KanbanStateInput } from './kanban-state';

function makeInput(overrides: Partial<KanbanStateInput> = {}): KanbanStateInput {
  return {
    lifecycle: WorkspaceStatus.READY,
    sessionIsWorking: false,
    flowIsWorking: false,
    prState: PRState.NONE,
    ratchetState: RatchetState.IDLE,
    pendingRequestType: null,
    hasSessionRuntimeError: false,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    ...overrides,
  };
}

describe('computeKanbanColumn', () => {
  it('hides archiving and archived workspaces', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.ARCHIVING }))).toBeNull();
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.ARCHIVED }))).toBeNull();
  });

  it('maps merged and closed pull requests to DONE before human-attention rules', () => {
    expect(
      computeKanbanColumn(
        makeInput({
          lifecycle: WorkspaceStatus.FAILED,
          prState: PRState.MERGED,
          pendingRequestType: 'permission_request',
        })
      )
    ).toBe('DONE');
    expect(computeKanbanColumn(makeInput({ prState: PRState.CLOSED }))).toBe('DONE');
    expect(computeKanbanColumn(makeInput({ ratchetState: RatchetState.MERGED }))).toBe('DONE');
  });

  it('maps explicit human-attention states to WAITING before automation-owned states', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.FAILED }))).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({ flowIsWorking: true, pendingRequestType: 'permission_request' })
      )
    ).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({ sessionIsWorking: true, pendingRequestType: 'plan_approval' })
      )
    ).toBe('WAITING');
    expect(computeKanbanColumn(makeInput({ pendingRequestType: 'user_question' }))).toBe('WAITING');
    expect(
      computeKanbanColumn(makeInput({ flowIsWorking: true, hasSessionRuntimeError: true }))
    ).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({
          ratchetState: RatchetState.CI_FAILED,
          flowIsWorking: true,
          ratchetDispatchOutcome: 'DIED',
          ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
        })
      )
    ).toBe('WAITING');
  });

  it('maps initializing, session-active, and flow-active workspaces to WORKING', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.NEW }))).toBe('WORKING');
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.PROVISIONING }))).toBe(
      'WORKING'
    );
    expect(computeKanbanColumn(makeInput({ sessionIsWorking: true }))).toBe('WORKING');
    expect(computeKanbanColumn(makeInput({ flowIsWorking: true }))).toBe('WORKING');
    expect(
      computeKanbanColumn(
        makeInput({
          flowIsWorking: true,
          ratchetDispatchOutcome: 'COMPLETED',
        })
      )
    ).toBe('WORKING');
  });

  it('maps remaining idle ready workspaces to WAITING', () => {
    expect(computeKanbanColumn(makeInput())).toBe('WAITING');
  });
});
