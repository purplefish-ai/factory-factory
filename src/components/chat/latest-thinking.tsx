import { Loader2 } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

// =============================================================================
// Props
// =============================================================================

interface LatestThinkingProps {
  /** Current accumulated thinking content */
  thinking: string | null;
  /** Whether the agent is actively running */
  running: boolean;
  /** Optional className for additional styling */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Displays the latest thinking content from extended thinking mode.
 * Shown below messages while the agent is running and has thinking content.
 * Auto-scrolls to keep the latest thinking visible.
 */
export const LatestThinking = memo(function LatestThinking({
  thinking,
  running,
  className,
}: LatestThinkingProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when thinking updates
  useEffect(() => {
    if (scrollRef.current && thinking) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thinking]);

  // Don't render if no thinking or not running
  if (!(thinking && running)) {
    return null;
  }

  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-3',
        className
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Thinking</span>
      </div>
      <div
        ref={scrollRef}
        className="text-sm text-muted-foreground italic max-h-32 overflow-y-auto whitespace-pre-wrap"
      >
        {thinking}
      </div>
    </div>
  );
});
