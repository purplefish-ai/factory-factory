import {
  type AutoIterationExecutionContext,
  workspaceAccessor,
} from '@/backend/services/workspace/resources/workspace.accessor';
import type { AutoIterationStatus } from '@/shared/core';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';

class WorkspaceAutoIterationService {
  getExecutionContext(workspaceId: string): Promise<AutoIterationExecutionContext | null> {
    return workspaceAccessor.findAutoIterationExecutionContext(workspaceId);
  }

  setStatus(workspaceId: string, status: AutoIterationStatus) {
    return workspaceAccessor.update(workspaceId, { autoIterationStatus: status });
  }

  setProgress(workspaceId: string, progress: AutoIterationProgress) {
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
