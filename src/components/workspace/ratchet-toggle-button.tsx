import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getRatchetStateLabel, type RatchetStateLike } from './ratchet-state';
import { RatchetWrenchIcon } from './ratchet-wrench-icon';

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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onPointerDown={(event) => {
            if (stopPropagation) {
              event.stopPropagation();
            }
          }}
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
          className={cn('h-7 w-7 p-0', className)}
        >
          <RatchetWrenchIcon enabled={enabled} state={state} className="h-full w-full" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{getTooltip(enabled, state)}</TooltipContent>
    </Tooltip>
  );
}
