import type { Workspace } from '@prisma-gen/browser';

/**
 * Creates an enriched workspace object with computed fields for optimistic cache updates.
 *
 * When creating a workspace, we immediately populate the workspace.get query cache
 * with this data so the detail page can show the workspace status (NEW/PROVISIONING)
 * without waiting for the server response.
 *
 * This must match the shape returned by the backend workspace.get endpoint.
 */
export function createOptimisticWorkspaceCacheData(workspace: Workspace) {
  return {
    ...workspace,
    sessionSummaries: [],
    agentSessions: [],
    terminalSessions: [],
    sidebarStatus: {
      activityState: 'IDLE' as const,
      ciState: 'NONE' as const,
    },
    ratchetButtonAnimated: false,
    flowPhase: 'NO_PR' as const,
    ciObservation: 'NOT_FETCHED' as const,
  };
}
