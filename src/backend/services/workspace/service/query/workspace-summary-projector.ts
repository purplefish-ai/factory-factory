import type { WorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import type { SessionSummary } from '@/shared/session-runtime';
import { deriveWorkspacePRSelection } from '@/shared/workspace-pr';
import { pickWorkspaceSummary, type WorkspaceSummary } from '@/shared/workspace-summary';

type WorkspaceSummarySource = Omit<
  WorkspaceSummary<Date>,
  | keyof WorkspaceDerivedState
  | 'sessionSummaries'
  | 'pendingRequestType'
  | 'gitStats'
  | 'lastActivityAt'
>;

/** Return the canonical board/sidebar projection. */
export function projectWorkspaceSummary(
  w: WorkspaceSummarySource,
  fields: {
    sessionSummaries: SessionSummary[];
    pendingRequestType: WorkspaceSummary['pendingRequestType'];
    gitStats: WorkspaceSummary['gitStats'];
    lastActivityAt: string | null;
    derivedState: WorkspaceDerivedState;
  }
): WorkspaceSummary<Date> {
  return pickWorkspaceSummary({
    ...w,
    ...deriveWorkspacePRSelection(w.prs),
    sessionSummaries: fields.sessionSummaries,
    pendingRequestType: fields.pendingRequestType,
    gitStats: fields.gitStats,
    lastActivityAt: fields.lastActivityAt,
    ...fields.derivedState,
  });
}
