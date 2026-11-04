import { StatusChip } from '@/client/components/status-indicators';
import { getPrStatePresentation } from '@/client/lib/status-tones';
import type { PRState } from '@/shared/core';

interface PrStateBadgeProps {
  prState?: PRState | null;
  size?: 'sm' | 'md';
  /**
   * Show every PR state (open, draft, merged, closed...). By default only Draft
   * is shown, for rows that already show terminal states through the CI chip.
   */
  showAllStates?: boolean;
}

export function PrStateBadge({ prState, size = 'sm', showAllStates = false }: PrStateBadgeProps) {
  const presentation = getPrStatePresentation(prState);
  if (!(presentation && (showAllStates || prState === 'DRAFT'))) {
    return null;
  }
  return (
    <StatusChip tone={presentation.tone} size={size} className="rounded-md">
      {presentation.label}
    </StatusChip>
  );
}
