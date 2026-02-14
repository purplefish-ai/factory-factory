/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */

import type {
  AcquireAndDispatchRequest,
  AcquireAndDispatchResponse,
} from '@/backend/services/fixer-workflow.service';

export type GitHubFixerAcquireInput = AcquireAndDispatchRequest;
export type GitHubFixerAcquireResult = AcquireAndDispatchResponse;

/** Session capabilities needed by GitHub domain */
export interface GitHubSessionBridge {
  isSessionWorking(sessionId: string): boolean;
  isSessionRunning(sessionId: string): boolean;
  sendSessionMessage(sessionId: string, message: string): Promise<void>;
}

/** Fixer session capability needed by GitHub domain */
export interface GitHubFixerBridge {
  acquireAndDispatch(input: GitHubFixerAcquireInput): Promise<GitHubFixerAcquireResult>;
  getActiveSession(
    workspaceId: string,
    workflow: string
  ): Promise<{ id: string; status: string } | null>;
}

/** Kanban state capability needed by GitHub domain */
export interface GitHubKanbanBridge {
  updateCachedKanbanColumn(workspaceId: string): Promise<void>;
}
