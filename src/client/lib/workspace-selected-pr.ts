import type { PRState, CIStatus } from '@/shared/core';
import { deriveWorkspacePRSelection, type WorkspacePullRequest } from '@/shared/workspace-pr';

type WorkspacePRSource = {
  id: string;
  prs?: readonly WorkspacePullRequest[];
  selectedPr?: WorkspacePullRequest | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: PRState | null;
  prCiStatus?: CIStatus | null;
};

/** Resolve link facts at the compatibility boundary; collection facts always win. */
export function getWorkspaceSelectedPR(workspace: WorkspacePRSource): WorkspacePullRequest | null {
  if (workspace.prs !== undefined) {
    return deriveWorkspacePRSelection(workspace.prs).selectedPr;
  }
  if (workspace.selectedPr !== undefined) {
    return workspace.selectedPr;
  }
  if (!workspace.prUrl) {
    return null;
  }
  // Old scalar-only HTTP/cache rows have no association identity or separate review facts.
  return {
    id: `legacy-pr-${workspace.id}`,
    identitySource: 'legacy-snapshot',
    url: workspace.prUrl,
    number: workspace.prNumber ?? null,
    title: null,
    headRefName: null,
    baseRefName: null,
    state: workspace.prState ?? 'NONE',
    reviewState: null,
    ciStatus: workspace.prCiStatus ?? 'UNKNOWN',
    hasMergeConflict: false,
    syncedAt: null,
  };
}

/** Persisted migrated/restored IDs may share synthetic spellings; use adapter provenance. */
export function getWorkspacePRAssociationId(
  pr: Pick<WorkspacePullRequest, 'id' | 'identitySource'> | null | undefined
) {
  return pr && pr.identitySource !== 'legacy-snapshot' ? pr.id : null;
}

/** Review routing must never submit a scalar adapter's synthetic display identity. */
export function getWorkspacePRReviewTarget(workspace: WorkspacePRSource) {
  const pr = getWorkspaceSelectedPR(workspace);
  return { pr, associationId: getWorkspacePRAssociationId(pr) };
}
