import { expect, it } from 'vitest';
import {
  deriveWorkspaceStatusReason,
  type WorkspaceStatusReasonInput,
} from './workspace-status-reason';

const base: WorkspaceStatusReasonInput = {
  lifecycle: 'READY',
  hasHadSessions: true,
  isWorking: false,
  isSessionStarting: false,
  pendingRequestType: null,
  flowPhase: 'RATCHET_FIXING',
  ciObservation: 'CHECKS_FAILED',
  prState: 'OPEN',
  prCiStatus: 'FAILURE',
  ratchetState: 'CI_FAILED',
  ratchetEnabled: true,
  hasMergeConflict: false,
  dispatchStalled: false,
  mode: 'STANDARD',
  autoIterationStatus: null,
};
it('reports a queued update as waiting until the recipient is actually working', () => {
  expect(
    deriveWorkspaceStatusReason({
      ...base,
      prMonitoring: {
        enabled: true,
        recipientSessionId: 'main',
        bindingRevision: 1,
        pauseReason: null,
        pendingEventCount: 1,
      },
    })
  ).toMatchObject({ code: 'PR_UPDATE_QUEUED', tone: 'waiting' });
  expect(deriveWorkspaceStatusReason({ ...base, isWorking: true })).toMatchObject({
    code: 'AGENT_WORKING',
    tone: 'working',
  });
});
it('reports a stopped recipient and an absent recipient without promising work', () => {
  expect(
    deriveWorkspaceStatusReason({
      ...base,
      prMonitoring: {
        enabled: true,
        recipientSessionId: 'main',
        bindingRevision: 1,
        pauseReason: 'USER_STOPPED',
        pendingEventCount: 1,
      },
    })
  ).toMatchObject({ code: 'PR_UPDATES_PAUSED', needsUser: true });
  expect(
    deriveWorkspaceStatusReason({
      ...base,
      prMonitoring: {
        enabled: true,
        recipientSessionId: null,
        bindingRevision: 1,
        pauseReason: null,
        pendingEventCount: 1,
      },
    })
  ).toMatchObject({ code: 'PR_RECIPIENT_REQUIRED', needsUser: true });
});
