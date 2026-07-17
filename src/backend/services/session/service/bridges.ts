/**
 * Bridge interfaces for session domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The session domain never imports from other domains directly.
 */

/** Workspace activity callbacks needed by session domain */
export interface SessionWorkspaceBridge {
  markSessionRunning(workspaceId: string, sessionId: string): number;
  markSessionIdle(workspaceId: string, sessionId: string, generation?: number): void;
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

/**
 * Outcome of a ratchet fixer session that has ended, as observed by the
 * session lifecycle: COMPLETED for deliberate stops / clean exits, DIED for
 * unexpected exits (which makes the dispatch eligible for a bounded retry).
 */
export type RatchetSessionEndOutcome = 'COMPLETED' | 'DIED';

/** Workspace callbacks needed by session lifecycle service */
export interface SessionLifecycleWorkspaceBridge {
  markSessionRunning(workspaceId: string, sessionId: string): number;
  markSessionIdle(workspaceId: string, sessionId: string, generation?: number): void;
  recordRatchetSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: RatchetSessionEndOutcome
  ): Promise<void>;
  resetPRDiscoveryBackoff(workspaceId: string): Promise<boolean>;
}

/** Queued message dispatch callback needed by session lifecycle service */
export interface SessionLifecycleMessageQueueBridge {
  tryDispatchNextMessage(sessionId: string): Promise<void>;
}

/** Auto-iteration exit notification bridge */
export interface SessionAutoIterationExitBridge {
  onAutoIterationSessionExit(workspaceId: string, sessionId: string): void;
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
