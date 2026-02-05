import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getRatchetVisualState, type RatchetStateLike } from './ratchet-state';

interface RatchetWrenchIconProps {
  enabled: boolean;
  state?: RatchetStateLike;
  className?: string;
  iconClassName?: string;
}

export function RatchetWrenchIcon({
  enabled,
  state = 'IDLE',
  className,
  iconClassName,
}: RatchetWrenchIconProps) {
  const visualState = getRatchetVisualState(enabled, state);

  return (
    <span
      aria-hidden="true"
      data-ratchet-state={visualState}
      className={cn('ratchet-toggle inline-flex items-center justify-center rounded-md', className)}
    >
      <Wrench
        className={cn(
          'h-3.5 w-3.5',
          enabled ? 'text-foreground' : 'text-muted-foreground',
          iconClassName
        )}
      />
    </span>
  );
}
