/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */

/** Session capabilities needed by GitHub domain */
export interface GitHubSessionBridge {
  isSessionWorking(sessionId: string): boolean;
  getClient(
    sessionId: string
  ): { isRunning(): boolean; sendMessage(msg: string): Promise<void> } | null;
}

/** Input for acquireAndDispatch (duplicated locally to avoid cross-domain dep on ratchet) */
export interface GitHubFixerAcquireInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  buildPrompt: () => string | Promise<string>;
  runningIdleAction: 'send_message' | 'restart' | 'already_active';
}

/** Result from acquireAndDispatch (duplicated locally to avoid cross-domain dep on ratchet) */
export type GitHubFixerAcquireResult =
  | { status: 'started'; sessionId: string; promptSent?: boolean }
  | { status: 'already_active'; sessionId: string; reason: 'working' | 'message_dispatched' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

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
