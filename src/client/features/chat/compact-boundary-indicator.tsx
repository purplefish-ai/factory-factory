import { ScissorsIcon } from '@phosphor-icons/react/dist/csr/Scissors';
import { memo, useId } from 'react';
import { cn } from '@/lib/utils';

export interface CompactBoundaryIndicatorProps {
  className?: string;
}

function DottedWave() {
  const patternId = useId();

  return (
    <svg aria-hidden="true" className="h-2 min-w-0 flex-1 text-muted-foreground/40">
      <defs>
        <pattern id={patternId} width="16" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M0 4 Q4 0 8 4 T16 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="0.5 3"
            strokeLinecap="round"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

/** Marks a context compaction boundary in the conversation. */
export const CompactBoundaryIndicator = memo(function CompactBoundaryIndicator({
  className,
}: CompactBoundaryIndicatorProps) {
  return (
    <div className={cn('my-2 flex items-center gap-3 py-3 text-muted-foreground', className)}>
      <DottedWave />
      <span className="flex shrink-0 items-center gap-2 text-xs">
        <ScissorsIcon aria-hidden="true" className="h-4 w-4" />
        Context compacted
      </span>
      <DottedWave />
    </div>
  );
});
