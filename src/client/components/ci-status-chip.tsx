import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { getCiStateTone, getStatusToneStyle } from '@/client/lib/status-tones';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  type PRState,
  getWorkspaceCiLabel,
  getWorkspaceCiTooltip,
  type WorkspaceSidebarCiState,
} from '@/shared/core';

interface CiStatusChipProps {
  ciState: WorkspaceSidebarCiState;
  prState?: PRState | null;
  size?: 'sm' | 'md';
  className?: string;
  showTooltip?: boolean;
}

const CI_STATE_ICONS: Record<WorkspaceSidebarCiState, Icon> = {
  PASSING: CheckCircleIcon,
  FAILING: XCircleIcon,
  RUNNING: ClockIcon,
  UNKNOWN: CircleIcon,
  CLOSED: XCircleIcon,
  MERGED: GitMergeIcon,
  CONFLICT: WarningIcon,
  NONE: CircleIcon,
};

export function CiStatusChip({
  ciState,
  prState,
  size = 'sm',
  className,
  showTooltip = true,
}: CiStatusChipProps) {
  if (ciState === 'NONE') {
    return null;
  }

  const Icon = CI_STATE_ICONS[ciState];
  const toneStyle = getStatusToneStyle(getCiStateTone(ciState));

  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  const iconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  const Tag = showTooltip ? 'button' : 'span';
  const chip = (
    <Tag
      type={showTooltip ? 'button' : undefined}
      aria-label={getWorkspaceCiTooltip(ciState, prState ?? null)}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm font-medium uppercase tracking-wide cursor-default',
        sizeClasses,
        toneStyle.chip,
        className
      )}
    >
      <Icon aria-hidden="true" className={iconSize} />
      <span>{getWorkspaceCiLabel(ciState)}</span>
    </Tag>
  );
  if (!showTooltip) {
    return chip;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="right">
        {getWorkspaceCiTooltip(ciState, prState ?? null)}
      </TooltipContent>
    </Tooltip>
  );
}
