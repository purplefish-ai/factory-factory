import type { Prisma } from '@prisma-gen/client';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { AutoIterationStatus } from '@/shared/core';

class WorkspaceAutoIterationService {
  getState(workspaceId: string) {
    return workspaceAccessor.findRawById(workspaceId);
  }

  setStatus(workspaceId: string, status: AutoIterationStatus) {
    return workspaceAccessor.update(workspaceId, { autoIterationStatus: status });
  }

  setProgress(workspaceId: string, progress: Prisma.InputJsonValue) {
    return workspaceAccessor.update(workspaceId, { autoIterationProgress: progress });
  }

  setSession(workspaceId: string, sessionId: string | null) {
    return workspaceAccessor.update(workspaceId, { autoIterationSessionId: sessionId });
  }

  finishSessionIfMatching(
    workspaceId: string,
    sessionId: string,
    status: AutoIterationStatus
  ): Promise<boolean> {
    return workspaceAccessor.finishAutoIterationIfSessionMatches(workspaceId, sessionId, status);
  }

  clearSessionIfMatching(workspaceId: string, sessionId: string): Promise<boolean> {
    return workspaceAccessor.clearAutoIterationSessionIfMatches(workspaceId, sessionId);
  }

  recoverStaleStatuses() {
    return workspaceAccessor.resetStaleAutoIterationStatuses();
  }
}

export const workspaceAutoIterationService = new WorkspaceAutoIterationService();
