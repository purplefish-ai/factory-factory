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
    isSessionStarting: false,
    hasMergeConflict: false,
    ratchetEnabled: false,
    dispatchStalled: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
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

  it('names every kind of pending request', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ pendingRequestType: 'plan_approval' }))
    ).toMatchObject({ code: 'NEEDS_PLAN_APPROVAL', needsUser: true });
    expect(
      deriveWorkspaceStatusReason(makeInput({ pendingRequestType: 'user_question' }))
    ).toMatchObject({ code: 'NEEDS_ANSWER', needsUser: true });
  });

  it('reports a session runtime error ahead of a pending PR flow state', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ hasSessionRuntimeError: true, isWorking: true, flowPhase: 'CI_WAIT' })
      )
    ).toMatchObject({ code: 'SESSION_ERROR', needsUser: true });
  });

  it('reports each lifecycle state that outranks PR flow', () => {
    expect(deriveWorkspaceStatusReason(makeInput({ lifecycle: 'NEW' }))).toMatchObject({
      code: 'SETTING_UP',
    });
    expect(deriveWorkspaceStatusReason(makeInput({ lifecycle: 'FAILED' }))).toMatchObject({
      code: 'SETUP_FAILED',
      needsUser: true,
    });
    expect(deriveWorkspaceStatusReason(makeInput({ lifecycle: 'ARCHIVING' }))).toMatchObject({
      code: 'ARCHIVING',
    });
    expect(deriveWorkspaceStatusReason(makeInput({ lifecycle: 'ARCHIVED' }))).toMatchObject({
      code: 'ARCHIVED',
    });
  });

  it('reports terminal pull requests', () => {
    expect(deriveWorkspaceStatusReason(makeInput({ prState: 'MERGED' }))).toMatchObject({
      code: 'MERGED',
    });
    expect(deriveWorkspaceStatusReason(makeInput({ ratchetState: 'MERGED' }))).toMatchObject({
      code: 'MERGED',
    });
    expect(deriveWorkspaceStatusReason(makeInput({ flowPhase: 'MERGED' }))).toMatchObject({
      code: 'MERGED',
    });
    expect(deriveWorkspaceStatusReason(makeInput({ prState: 'CLOSED' }))).toMatchObject({
      code: 'PR_CLOSED',
    });
  });

  it('reports an unverified pull request as being checked', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ flowPhase: 'RATCHET_VERIFY', prState: 'OPEN', ratchetEnabled: true })
      )
    ).toMatchObject({ code: 'CHECKING_PR', tone: 'working', needsUser: false });
  });

  it('falls back to awaiting the next prompt for an idle workspace with sessions', () => {
    expect(deriveWorkspaceStatusReason(makeInput())).toMatchObject({
      code: 'READY_FOR_NEXT_PROMPT',
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

  it('reports a spawning session as starting rather than idle', () => {
    expect(deriveWorkspaceStatusReason(makeInput({ isSessionStarting: true }))).toMatchObject({
      code: 'STARTING_SESSION',
      label: 'Starting session',
      tone: 'working',
      needsUser: false,
    });
  });

  it('lets a pending request outrank a starting session', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ isSessionStarting: true, pendingRequestType: 'permission_request' })
      )
    ).toMatchObject({ code: 'NEEDS_PERMISSION' });
  });

  it('lets provisioning outrank a starting session', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ isSessionStarting: true, lifecycle: 'PROVISIONING' }))
    ).toMatchObject({ code: 'SETTING_UP' });
  });

  it('reports a running auto-iteration loop between sessions as working', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING' })
      )
    ).toMatchObject({ code: 'AUTO_ITERATING', tone: 'working', needsUser: false });
  });

  it('prefers the live session over the loop when both are active', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING', isWorking: true })
      )
    ).toMatchObject({ code: 'AGENT_WORKING' });
  });

  it('reports a conflicted PR as being fixed when the ratchet is on', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({
          hasMergeConflict: true,
          ratchetEnabled: true,
          ratchetState: 'MERGE_CONFLICT',
          flowPhase: 'RATCHET_VERIFY',
          prState: 'OPEN',
        })
      )
    ).toMatchObject({ code: 'FIXING_MERGE_CONFLICT', tone: 'working', needsUser: false });
  });

  it('reports a conflicted PR as needing a human when the ratchet is off', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({
          hasMergeConflict: true,
          ratchetEnabled: false,
          flowPhase: 'READY',
          ciObservation: 'CHECKS_PASSED',
          prState: 'OPEN',
        })
      )
    ).toMatchObject({ code: 'MERGE_CONFLICT', tone: 'attention', needsUser: true });
  });

  it('does not let stale PR facts speak for a workspace with no pull request', () => {
    // hasMergeConflict and dispatchStalled are cached facts about a PR. A
    // workspace whose PR went away while one was set must still report its idle
    // reason, not "Merge conflict" or "Auto-fix stalled".
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ flowPhase: 'NO_PR', hasMergeConflict: true, prState: 'NONE' })
      )
    ).toMatchObject({ code: 'READY_FOR_NEXT_PROMPT' });

    expect(
      deriveWorkspaceStatusReason(
        makeInput({
          flowPhase: 'NO_PR',
          ratchetEnabled: true,
          dispatchStalled: true,
          prState: 'NONE',
          hasHadSessions: false,
        })
      )
    ).toMatchObject({ code: 'NO_SESSION_STARTED' });
  });

  it('reports a stalled auto-fix ahead of the fixing states', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({
          ratchetEnabled: true,
          dispatchStalled: true,
          ratchetState: 'CI_FAILED',
          flowPhase: 'RATCHET_FIXING',
          prState: 'OPEN',
        })
      )
    ).toMatchObject({ code: 'RATCHET_STALLED', tone: 'attention', needsUser: true });
  });

  it('lets a merged PR outrank a pending permission request', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ prState: 'MERGED', pendingRequestType: 'permission_request' })
      )
    ).toMatchObject({ code: 'MERGED' });
  });

  it('lets a merged PR outrank a FAILED lifecycle', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ prState: 'MERGED', lifecycle: 'FAILED' }))
    ).toMatchObject({ code: 'MERGED' });
  });

  it('lets a merged PR outrank a session runtime error', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ prState: 'MERGED', hasSessionRuntimeError: true }))
    ).toMatchObject({ code: 'MERGED' });
  });

  it('lets archiving outrank a merged PR', () => {
    expect(
      deriveWorkspaceStatusReason(makeInput({ lifecycle: 'ARCHIVING', prState: 'MERGED' }))
    ).toMatchObject({ code: 'ARCHIVING' });
  });

  it('marks a reviewable pull request as needing the user', () => {
    expect(
      deriveWorkspaceStatusReason(
        makeInput({ flowPhase: 'READY', ciObservation: 'CHECKS_PASSED', prState: 'OPEN' })
      )
    ).toMatchObject({ code: 'READY_TO_MERGE', needsUser: true });

    expect(
      deriveWorkspaceStatusReason(
        makeInput({ flowPhase: 'READY', ciObservation: 'CHECKS_FAILED', prState: 'OPEN' })
      )
    ).toMatchObject({ code: 'READY_FOR_REVIEW', needsUser: true });
  });
});
