import { memo } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

// =============================================================================
// Props
// =============================================================================

interface CompactingIndicatorProps {
  /** Whether context compaction is in progress */
  isCompacting: boolean;
  /** Optional className for additional styling */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Displays an indicator when the Claude CLI is compacting context.
 * Shown when the SDK reports context compaction is in progress.
 */
export const CompactingIndicator = memo(function CompactingIndicator({
  isCompacting,
  className,
}: CompactingIndicatorProps) {
  // Don't render if not compacting
  if (!isCompacting) {
    return null;
  }

  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-3',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <Spinner aria-hidden="true" className="size-3 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Compacting context…</span>
      </div>
    </div>
  );
});
