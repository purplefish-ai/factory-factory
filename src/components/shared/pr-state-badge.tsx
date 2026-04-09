import { Badge } from '@/components/ui/badge';
import type { PRState } from '@/shared/core';

interface PrStateBadgeProps {
  prState?: PRState | null;
  size?: 'sm' | 'md';
}

export function PrStateBadge({ prState, size = 'sm' }: PrStateBadgeProps) {
  if (prState !== 'DRAFT') {
    return null;
  }

  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';

  return (
    <Badge
      variant="outline"
      className={`${sizeClasses} border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300`}
    >
      Draft
    </Badge>
  );
}
