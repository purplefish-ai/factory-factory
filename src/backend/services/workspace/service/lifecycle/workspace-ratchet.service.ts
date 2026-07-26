import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import { workspaceRatchetAccessor } from '@/backend/services/workspace/resources/workspace-ratchet.accessor';
import type { RatchetState } from '@/shared/core';

/**
 * The workspace capsule's public surface for ratchet state, used by the ratchet
 * capsule through the barrel.
 *
 * Every method delegates to `workspaceRatchetAccessor`, the sole writer of the
 * `WorkspaceRatchet` table.
 */
class WorkspaceRatchetService {
  findCandidates() {
    return workspaceRatchetAccessor.findWithPRsForRatchet();
  }

  findCandidateById(workspaceId: string) {
    return workspaceRatchetAccessor.findForRatchetById(workspaceId);
  }

  recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ) {
    return workspaceRatchetAccessor.recordSessionEnd(workspaceId, sessionId, outcome);
  }

  recordDispatchIfEnabled(
    workspaceId: string,
    input: { sessionId: string; snapshotKey: string; retryCount: number }
  ) {
    return workspaceRatchetAccessor.recordDispatchIfEnabled(workspaceId, input);
  }

  adoptActiveSessionIfEnabled(workspaceId: string, sessionId: string) {
    return workspaceRatchetAccessor.adoptActiveSessionIfEnabled(workspaceId, sessionId);
  }

  transitionStateIfEnabled(
    workspaceId: string,
    from: RatchetState,
    data: { ratchetState: RatchetState; ratchetLastCheckedAt: Date }
  ) {
    return workspaceRatchetAccessor.transitionStateIfEnabled(workspaceId, from, data);
  }

  settleIdleWhileDisabled(workspaceId: string, from: RatchetState) {
    return workspaceRatchetAccessor.settleIdleWhileDisabled(workspaceId, from);
  }

  clearActiveSession(workspaceId: string, sessionId: string) {
    return workspaceRatchetAccessor.clearActiveSession(workspaceId, sessionId);
  }

  enable(workspaceId: string) {
    return workspaceRatchetAccessor.enable(workspaceId);
  }

  disable(workspaceId: string) {
    return workspaceRatchetAccessor.disable(workspaceId);
  }
}

export const workspaceRatchetService = new WorkspaceRatchetService();
