import { createLogger } from '@/backend/services/logger.service';
import type { sessionDataService } from '@/backend/services/session';
import type {
  workspaceDataService,
  workspacePrSnapshotService,
  WorkspaceSnapshotStore,
} from '@/backend/services/workspace';

const logger = createLogger('workspace-follow-up');

interface Ports {
  sessionDataService: Pick<typeof sessionDataService, 'findAgentSessionById'>;
  workspaceDataService: Pick<typeof workspaceDataService, 'findById'>;
  workspacePrSnapshotService: Pick<typeof workspacePrSnapshotService, 'dismissCompletedPRs'>;
  workspaceSnapshotStore: Pick<WorkspaceSnapshotStore, 'upsert' | 'getByWorkspaceId'>;
}

/** Only explicit human queue admission calls this; background prompts bypass it. */
export function createWorkspaceFollowUp(ports: Ports) {
  return async (sessionId: string, acceptedAt: Date): Promise<void> => {
    const session = await ports.sessionDataService.findAgentSessionById(sessionId);
    if (!session) {
      return;
    }
    const changed = await ports.workspacePrSnapshotService.dismissCompletedPRs(
      session.workspaceId,
      acceptedAt
    );
    if (!changed) {
      return;
    }
    try {
      const workspace = await ports.workspaceDataService.findById(session.workspaceId);
      if (!workspace || workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED') {
        return;
      }
      const previous = ports.workspaceSnapshotStore.getByWorkspaceId(workspace.id);
      const timestamp = Math.max(
        Date.now(),
        (previous?.fieldTimestamps.pr ?? 0) + 1,
        (previous?.fieldTimestamps.ratchet ?? 0) + 1
      );
      ports.workspaceSnapshotStore.upsert(
        workspace.id,
        {
          projectId: workspace.projectId,
          prs: workspace.prs,
          prSummary: workspace.prSummary,
          prState: workspace.prState,
          prCiStatus: workspace.prCiStatus,
          ratchetState: workspace.ratchetState,
          hasMergeConflict: workspace.prHasMergeConflict,
        },
        'human_follow_up',
        timestamp
      );
    } catch (error) {
      // The durable admission has committed. Reconciliation retries publication.
      logger.warn('Workspace reopened; snapshot publication deferred', {
        workspaceId: session.workspaceId,
        error,
      });
    }
  };
}
