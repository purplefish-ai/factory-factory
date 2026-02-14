import { CheckCircle2, Circle, type LucideIcon, XCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PRState } from '@/shared/core';
import {
  getWorkspaceCiLabel,
  getWorkspaceCiTooltip,
  type WorkspaceSidebarCiState,
} from '@/shared/workspace-sidebar-status';

interface CiStatusChipProps {
  ciState: WorkspaceSidebarCiState;
  prState?: PRState | null;
  size?: 'sm' | 'md';
  className?: string;
}

function getCiStatusConfig(ciState: WorkspaceSidebarCiState): {
  className: string;
  Icon: LucideIcon;
} {
  switch (ciState) {
    case 'PASSING':
      return {
        className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        Icon: CheckCircle2,
      };
    case 'FAILING':
      return {
        className: 'bg-red-500/15 text-red-700 dark:text-red-300',
        Icon: XCircle,
      };
    case 'RUNNING':
      return {
        className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
        Icon: Circle,
      };
    case 'UNKNOWN':
      return {
        className: 'bg-muted text-muted-foreground',
        Icon: Circle,
      };
    case 'MERGED':
      return {
        className: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
        Icon: CheckCircle2,
      };
    case 'NONE':
      return {
        className: 'bg-transparent text-muted-foreground',
        Icon: Circle,
      };
  }
}

export function CiStatusChip({ ciState, prState, size = 'sm', className }: CiStatusChipProps) {
  if (ciState === 'NONE') {
    return null;
  }

  const config = getCiStatusConfig(ciState);
  const { Icon } = config;

  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  const iconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={getWorkspaceCiTooltip(ciState, prState ?? null)}
          className={cn(
            'inline-flex w-fit items-center gap-1 rounded-sm font-medium uppercase tracking-wide cursor-default',
            sizeClasses,
            config.className,
            className
          )}
        >
          <Icon className={cn(iconSize, ciState === 'RUNNING' && 'animate-pulse')} />
          <span>{getWorkspaceCiLabel(ciState)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {getWorkspaceCiTooltip(ciState, prState ?? null)}
      </TooltipContent>
    </Tooltip>
  );
}
