import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { cn } from '@/lib/utils';

interface AgentSessionStatusProps {
  label: string;
  icon: Icon;
  color: string;
  pulse?: boolean;
  spin?: boolean;
}

export function AgentSessionStatus({
  label,
  icon: StatusIcon,
  color,
  pulse,
  spin,
}: AgentSessionStatusProps) {
  return (
    <span
      role="img"
      aria-label={`Agent: ${label}`}
      className={cn('inline-flex shrink-0 items-center gap-0.5', color)}
    >
      <RobotIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <StatusIcon
        aria-hidden="true"
        className={cn('h-2.5 w-2.5 shrink-0', pulse && 'animate-pulse', spin && 'animate-spin')}
      />
    </span>
  );
}
