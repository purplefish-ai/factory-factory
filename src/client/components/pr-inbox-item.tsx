import { forwardRef } from 'react';
import { DIFF_STAT_CLASS_NAMES } from '@/client/lib/status-tones';
import { formatRelativeTime } from '@/lib/utils';
import type { PRWithFullDetails } from '@/shared/github-types';
import { CIStatusDot } from './pr-status-badges';
import { StatusChip } from './status-indicators';

function formatRelativeTimeWithAgo(dateString: string): string {
  const relative = formatRelativeTime(dateString);
  if (!relative || relative === 'now') {
    return relative;
  }
  return `${relative} ago`;
}

export interface PRInboxItemProps {
  pr: PRWithFullDetails;
  isSelected: boolean;
  onSelect: () => void;
}

export const PRInboxItem = forwardRef<HTMLButtonElement, PRInboxItemProps>(function PRInboxItem(
  { pr, isSelected, onSelect },
  ref
) {
  const needsReview = pr.reviewDecision !== 'APPROVED';
  const isApproved = pr.reviewDecision === 'APPROVED';

  return (
    <button
      type="button"
      ref={ref}
      data-review-row
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
      className={`cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border px-3 py-2 rounded-md w-full max-w-full overflow-hidden text-left ${
        isSelected ? 'bg-muted border-border shadow-sm' : 'border-transparent hover:bg-muted/50'
      }`}
    >
      <div className="flex items-start gap-2 w-full">
        {/* CI Status indicator */}
        <div className="flex-shrink-0 mt-1 w-3 flex items-center justify-center">
          <CIStatusDot checks={pr.statusCheckRollup} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-primary/70 truncate max-w-[120px]">
              {pr.repository.name}
            </span>
            <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
              #{pr.number}
            </span>
            {pr.isDraft && (
              <StatusChip tone="neutral" size="md">
                Draft
              </StatusChip>
            )}
            {needsReview && (
              <StatusChip tone="attention" size="md">
                Review
              </StatusChip>
            )}
            {isApproved && (
              <StatusChip tone="success" size="md">
                Approved
              </StatusChip>
            )}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatRelativeTimeWithAgo(pr.updatedAt)}
            </span>
          </div>

          <div className="font-medium text-sm truncate leading-tight" title={pr.title}>
            {pr.title}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate max-w-[80px]">{pr.author.login}</span>
            <span className={`whitespace-nowrap ${DIFF_STAT_CLASS_NAMES.added}`}>
              +{pr.additions}
            </span>
            <span className={`whitespace-nowrap ${DIFF_STAT_CLASS_NAMES.removed}`}>
              -{pr.deletions}
            </span>
            {pr.comments.length > 0 && (
              <span className="whitespace-nowrap">{pr.comments.length} comments</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
});
