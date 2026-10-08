import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import { workspaceRatchetAccessor } from '@/backend/services/workspace/resources/workspace-ratchet.accessor';

/**
 * The workspace capsule's public surface for the ratchet row, used by the ratchet
 * capsule through the barrel.
 *
 * There is no state accessor here: `RatchetState` is derived from the PR cache
 * (`deriveRatchetState`) and arrives already projected on every workspace read.
 *
 * Every method delegates to `workspaceRatchetAccessor`, the sole writer of the
 * `WorkspaceRatchet` table.
 */
class WorkspaceRatchetService {
  restoreOwnership(...args: Parameters<typeof workspaceRatchetAccessor.restoreOwnership>) {
    return workspaceRatchetAccessor.restoreOwnership(...args);
  }

  findCandidates() {
    return workspaceRatchetAccessor.findWithPRsForRatchet();
  }

  findCandidateById(workspaceId: string, prId?: string) {
    return workspaceRatchetAccessor.findForRatchetById(workspaceId, prId);
  }

  findCandidatesById(workspaceId: string) {
    return workspaceRatchetAccessor.findAllForRatchetById(workspaceId);
  }

  recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ) {
    return workspaceRatchetAccessor.recordSessionEnd(workspaceId, sessionId, outcome);
  }

  markDispatchStalled(workspaceId: string, snapshotKey: string, prId?: string) {
    return workspaceRatchetAccessor.markDispatchStalled(workspaceId, snapshotKey, prId);
  }

  recordDispatchIfEnabled(
    workspaceId: string,
    input: {
      sessionId: string;
      snapshotKey: string;
      retryCount: number;
      prId?: string;
      expectedRevision?: number;
    }
  ) {
    return workspaceRatchetAccessor.recordDispatchIfEnabled(workspaceId, input);
  }

  adoptActiveSessionIfEnabled(workspaceId: string, sessionId: string, prId?: string) {
    return workspaceRatchetAccessor.adoptActiveSessionIfEnabled(workspaceId, sessionId, prId);
  }

  recordCheckIfEnabled(workspaceId: string, checkedAt: Date, prId?: string) {
    return workspaceRatchetAccessor.recordCheckIfEnabled(workspaceId, checkedAt, prId);
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
