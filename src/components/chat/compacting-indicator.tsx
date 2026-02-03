import { Loader2 } from 'lucide-react';
import { memo } from 'react';
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
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Compacting context...</span>
      </div>
    </div>
  );
});
