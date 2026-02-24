/**
 * Bridge interfaces for session domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The session domain never imports from other domains directly.
 */

/** Workspace activity callbacks needed by session domain */
export interface SessionWorkspaceBridge {
  markSessionRunning(workspaceId: string, sessionId: string): void;
  markSessionIdle(workspaceId: string, sessionId: string): void;
  on(
    event: 'request_notification',
    handler: (data: {
      workspaceId: string;
      workspaceName: string;
      sessionCount: number;
      finishedAt: Date;
    }) => void
  ): void;
}

/** Workspace callbacks needed by session lifecycle service */
export interface SessionLifecycleWorkspaceBridge {
  markSessionRunning(workspaceId: string, sessionId: string): void;
  markSessionIdle(workspaceId: string, sessionId: string): void;
  clearRatchetActiveSessionIfMatching(workspaceId: string, sessionId: string): Promise<void>;
}

/** Workspace init policy callback needed by session domain */
export interface SessionInitPolicyBridge {
  getWorkspaceInitPolicy(input: SessionInitPolicyInput): SessionInitPolicyResult;
}

/** Locally-defined input type for workspace init policy (avoids cross-domain dep) */
export interface SessionInitPolicyInput {
  status: string;
  worktreePath?: string | null;
  initErrorMessage?: string | null;
}

/** Locally-defined result type for workspace init policy (avoids cross-domain dep) */
export interface SessionInitPolicyResult {
  dispatchPolicy: 'allowed' | 'blocked' | 'manual_resume';
}
