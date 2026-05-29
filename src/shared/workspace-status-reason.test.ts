import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceStatusReason,
  type WorkspaceStatusReasonInput,
} from './workspace-status-reason';

function makeInput(
  overrides: Partial<WorkspaceStatusReasonInput> = {}
): WorkspaceStatusReasonInput {
  return {
    lifecycle: 'READY',
    hasHadSessions: true,
    isWorking: false,
    pendingRequestType: null,
    flowPhase: 'NO_PR',
    ciObservation: 'CHECKS_UNKNOWN',
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetState: 'IDLE',
    runScriptStatus: 'IDLE',
    ...overrides,
  };
}

describe('deriveWorkspaceStatusReason', () => {
  it('prioritizes pending user action', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ pendingRequestType: 'permission_request' }))
    ).toMatchObject({
      code: 'NEEDS_PERMISSION',
      label: 'Needs permission',
      needsUser: true,
    });
  });

  it('labels idle empty workspaces as no session started', () => {
    expect(deriveWorkspaceStatusReason(makeInput({ hasHadSessions: false }))).toMatchObject({
      code: 'NO_SESSION_STARTED',
      label: 'No session started',
      needsUser: true,
    });
  });

  it('explains PR automation states', () => {
    expect(deriveWorkspaceStatusReason(makeInput({ flowPhase: 'CI_WAIT' })).label).toBe(
      'Waiting for CI'
    );
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ flowPhase: 'RATCHET_FIXING', ratchetState: 'REVIEW_PENDING' })
      ).label
    ).toBe('Fixing review comments');
  });

  it('shows active agent work before passive PR state', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({
          isWorking: true,
          flowPhase: 'CI_WAIT',
        })
      )
    ).toMatchObject({
      code: 'AGENT_WORKING',
      label: 'Agent working',
    });
  });
});
