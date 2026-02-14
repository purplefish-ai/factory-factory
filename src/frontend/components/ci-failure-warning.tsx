import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { CIStatus } from '@/shared/core';

interface CIFailureWarningProps {
  ciStatus: CIStatus;
  prUrl?: string | null;
  size?: 'sm' | 'md';
}

export function CIFailureWarning({ ciStatus, prUrl, size = 'sm' }: CIFailureWarningProps) {
  if (ciStatus !== 'FAILURE') {
    return null;
  }

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center">
            <AlertTriangle className={`${iconSize} text-destructive`} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-sm">CI checks are failing</p>
          {prUrl && <p className="text-xs text-muted-foreground mt-1">Check the PR for details</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
