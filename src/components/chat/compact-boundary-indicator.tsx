'use client';

import { Scissors } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';

interface CompactBoundaryIndicatorProps {
  className?: string;
}

/**
 * Visual indicator showing that context has been compacted.
 * Displayed when Claude CLI sends a compact_boundary system message,
 * indicating that earlier messages may be summarized.
 */
export const CompactBoundaryIndicator = memo(function CompactBoundaryIndicator({
  className,
}: CompactBoundaryIndicatorProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 py-3 my-2 border-t border-b border-dashed border-muted-foreground/30',
        className
      )}
    >
      <Scissors className="h-4 w-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">
        Context compacted - earlier messages may be summarized
      </span>
    </div>
  );
});
