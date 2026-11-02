import { eventRunResults } from '@/backend/services/agent-definition';
import type { WorkspaceDeletionCapture } from '@/backend/services/workspace';
import { compactAgentRunResult } from '@/shared/agent-run-result';

/** Runs only inside the workspace owner's deletion transaction. */
export const captureWorkspaceRunResults: WorkspaceDeletionCapture = (tx, snapshot) =>
  eventRunResults.captureWorkspace(tx, {
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    originRunId: snapshot.originRunId,
    result: compactAgentRunResult(snapshot.prs),
  });
