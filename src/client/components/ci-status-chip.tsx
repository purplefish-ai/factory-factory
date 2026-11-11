import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { StatusChip } from '@/client/components/status-indicators';
import { getCiStateTone } from '@/client/lib/status-tones';
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

/** The combined CI/PR state as a status chip, with its explanation as a hover title. */
export function CiStatusChip({ ciState, prState, size = 'sm', className }: CiStatusChipProps) {
  if (ciState === 'NONE') {
    return null;
  }
  return (
    <StatusChip
      tone={getCiStateTone(ciState)}
      icon={CI_STATE_ICONS[ciState]}
      size={size}
      title={getWorkspaceCiTooltip(ciState, prState ?? null)}
      className={className}
    >
      {getWorkspaceCiLabel(ciState)}
    </StatusChip>
  );
}
