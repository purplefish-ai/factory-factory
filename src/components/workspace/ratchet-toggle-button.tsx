import { Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  getRatchetStateLabel,
  getRatchetVisualState,
  type RatchetStateLike,
} from './ratchet-state';

interface RatchetToggleButtonProps {
  enabled: boolean;
  state: RatchetStateLike;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
  stopPropagation?: boolean;
  className?: string;
}

function getTooltip(enabled: boolean, state: RatchetStateLike): string {
  const stateLabel = getRatchetStateLabel(state);
  if (!enabled) {
    return 'Ratcheting is off. Click to enable.';
  }
  return `Ratcheting is on (${stateLabel}). Click to disable.`;
}

export function RatchetToggleButton({
  enabled,
  state,
  onToggle,
  disabled = false,
  stopPropagation = false,
  className,
}: RatchetToggleButtonProps) {
  const visualState = getRatchetVisualState(enabled, state);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={(event) => {
            if (stopPropagation) {
              event.preventDefault();
              event.stopPropagation();
            }
            onToggle(!enabled);
          }}
          disabled={disabled}
          aria-label={enabled ? 'Disable ratcheting' : 'Enable ratcheting'}
          aria-pressed={enabled}
          data-ratchet-state={visualState}
          className={cn('ratchet-toggle h-7 w-7', className)}
        >
          <Wrench
            className={cn('h-3.5 w-3.5', enabled ? 'text-foreground' : 'text-muted-foreground')}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{getTooltip(enabled, state)}</TooltipContent>
    </Tooltip>
  );
}
