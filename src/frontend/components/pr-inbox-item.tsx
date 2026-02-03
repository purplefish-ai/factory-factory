import { forwardRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/utils';
import type { PRWithFullDetails } from '@/shared/github-types';
import { CIStatusDot } from './pr-status-badges';

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

export const PRInboxItem = forwardRef<HTMLDivElement, PRInboxItemProps>(function PRInboxItem(
  { pr, isSelected, onSelect },
  ref
) {
  const needsReview = pr.reviewDecision !== 'APPROVED';
  const isApproved = pr.reviewDecision === 'APPROVED';

  return (
    // biome-ignore lint/a11y/useSemanticElements: div allows complex nested layout styling
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer transition-all outline-none border px-3 py-2 rounded-md w-full max-w-full overflow-hidden ${
        isSelected
          ? 'bg-muted border-border shadow-sm'
          : isApproved
            ? 'border-transparent hover:bg-muted/50'
            : 'border-transparent hover:bg-muted/50'
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
              <Badge variant="outline" className="text-xs">
                Draft
              </Badge>
            )}
            {needsReview && (
              <Badge className="bg-orange-500/10 text-orange-700 border-orange-500/20 text-xs">
                Review
              </Badge>
            )}
            {isApproved && (
              <Badge className="bg-green-500/10 text-green-700 border-green-500/20 text-xs">
                Approved
              </Badge>
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
            <span className="text-green-600 whitespace-nowrap">+{pr.additions}</span>
            <span className="text-red-600 whitespace-nowrap">-{pr.deletions}</span>
            {pr.comments.length > 0 && (
              <span className="whitespace-nowrap">{pr.comments.length} comments</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
