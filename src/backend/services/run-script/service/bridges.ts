/**
 * Bridge interfaces for run-script domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The run-script domain never imports from other domains directly.
 */

/** Workspace state transitions and persisted initialization state needed by run-script. */
export interface RunScriptWorkspaceBridge {
  markReady(workspaceId: string): Promise<unknown>;
  markFailed(workspaceId: string, errorMessage: string): Promise<unknown>;
  clearInitOutput(workspaceId: string): Promise<unknown>;
  appendInitOutput(workspaceId: string, output: string, maxSize?: number): Promise<unknown>;
  setInitScriptPid(workspaceId: string, pid: number): Promise<unknown>;
  clearInitScriptPid(workspaceId: string, pid: number): Promise<unknown>;
}
