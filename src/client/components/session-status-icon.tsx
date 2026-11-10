import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import type { SessionTabRuntimeInfo } from '@/client/lib/session-tab-runtime';
import { cn } from '@/lib/utils';

interface SessionStatusIconProps {
  /** From `deriveSessionTabRuntime`, the one session status → icon and color map. */
  status: SessionTabRuntimeInfo;
  /** Agent (periodic-task) sessions show a robot beside a smaller status glyph. */
  isAgent?: boolean;
}

/** A session tab's status glyph, shared by the workspace and quick-chat tab bars. */
export function SessionStatusIcon({ status, isAgent = false }: SessionStatusIconProps) {
  const { icon: Icon, color, label, pulse, spin } = status;
  const motion = cn(pulse && 'animate-pulse', spin && 'animate-spin');
  if (isAgent) {
    return (
      <span
        role="img"
        aria-label={`Agent: ${label}`}
        className={cn('inline-flex shrink-0 items-center gap-0.5', color)}
      >
        <RobotIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <Icon aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0', motion)} />
      </span>
    );
  }
  return (
    <Icon role="img" aria-label={label} className={cn('h-3.5 w-3.5 shrink-0', color, motion)} />
  );
}
