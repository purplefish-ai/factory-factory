'use client';

import { forwardRef } from 'react';
import type { PRWithFullDetails } from '@/shared/github-types';
import { CIStatusDot } from './pr-status-badges';

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
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
      className={`cursor-pointer transition-all outline-none border-l-2 px-2 py-1.5 rounded-sm w-full max-w-full overflow-hidden ${
        isSelected ? 'bg-blue-500/10 border-l-blue-500' : 'border-l-orange-500 hover:bg-muted/50'
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
            <span className="font-mono text-[10px] text-primary/70 truncate max-w-[100px]">
              {pr.repository.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
              #{pr.number}
            </span>
            {pr.isDraft && (
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">[draft]</span>
            )}
            {needsReview && (
              <span className="text-[10px] font-medium text-orange-600 bg-orange-500/10 px-1 rounded whitespace-nowrap">
                Review
              </span>
            )}
            {isApproved && (
              <span className="text-[10px] font-medium text-green-600 bg-green-500/10 px-1 rounded whitespace-nowrap">
                Approved
              </span>
            )}
            <span className="flex-1" />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {formatRelativeTime(pr.updatedAt)}
            </span>
          </div>

          <div className="font-medium text-[13px] truncate leading-tight" title={pr.title}>
            {pr.title}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
