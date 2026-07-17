import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { RatchetState } from '@/shared/core';

class WorkspaceRatchetService {
  findCandidates() {
    return workspaceAccessor.findWithPRsForRatchet();
  }

  findCandidateById(workspaceId: string) {
    return workspaceAccessor.findForRatchetById(workspaceId);
  }

  recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ) {
    return workspaceAccessor.recordRatchetSessionEnd(workspaceId, sessionId, outcome);
  }

  recordDispatchIfEnabled(
    workspaceId: string,
    input: { sessionId: string; snapshotKey: string; retryCount: number }
  ) {
    return workspaceAccessor.recordRatchetDispatchIfEnabled(workspaceId, input);
  }

  adoptActiveSessionIfEnabled(workspaceId: string, sessionId: string) {
    return workspaceAccessor.adoptRatchetActiveSessionIfEnabled(workspaceId, sessionId);
  }

  transitionStateIfEnabled(
    workspaceId: string,
    from: RatchetState,
    data: { ratchetState: RatchetState; ratchetLastCheckedAt: Date }
  ) {
    return workspaceAccessor.transitionRatchetStateIfEnabled(workspaceId, from, data);
  }

  settleIdleWhileDisabled(workspaceId: string, from: RatchetState) {
    return workspaceAccessor.settleRatchetIdleWhileDisabled(workspaceId, from);
  }

  clearActiveSession(workspaceId: string) {
    return workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: null });
  }

  enable(workspaceId: string) {
    return workspaceAccessor.update(workspaceId, { ratchetEnabled: true });
  }

  disable(workspaceId: string) {
    return workspaceAccessor.update(workspaceId, {
      ratchetEnabled: false,
      ratchetState: 'IDLE',
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    });
  }
}

export const workspaceRatchetService = new WorkspaceRatchetService();
