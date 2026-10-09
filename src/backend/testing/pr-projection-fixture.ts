import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
export const prProjectionDefaults = {
  prs: [],
  prSummary: deriveWorkspacePRSummary([], true),
  prUrl: null,
  prNumber: null,
  prState: 'NONE' as const,
  prCiStatus: 'UNKNOWN' as const,
  prUpdatedAt: null,
};
