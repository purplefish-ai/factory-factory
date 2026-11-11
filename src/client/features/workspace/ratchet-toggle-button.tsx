import type { MouseEvent, PointerEvent } from 'react';
import { IconButton } from '@/client/components/icon-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getRatchetStateLabel, type RatchetStateLike } from './ratchet-state';
import { RatchetWrenchIcon } from './ratchet-wrench-icon';

interface RatchetToggleButtonProps {
  enabled: boolean;
  state: RatchetStateLike;
  animated?: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
  /** A toggle for this workspace is in flight. */
  pending?: boolean;
  stopPropagation?: boolean;
  className?: string;
  /** Size of the icon-only button; a labelled button is always `compact`. */
  size?: 'icon-xs' | 'icon-compact';
  label?: string;
}

/** One name in both states: `aria-pressed` says whether PR updates are on. */
const ACCESSIBLE_NAME = 'PR updates';

function getTooltip(enabled: boolean, state: RatchetStateLike): string {
  if (!enabled) {
    return 'PR updates are off. Click to queue CI and review updates in the main conversation.';
  }
  const stateLabel = getRatchetStateLabel(state);
  return `PR updates are on (${stateLabel}). Click to disable.`;
}

export function RatchetToggleButton({
  enabled,
  state,
  animated = false,
  onToggle,
  disabled = false,
  pending = false,
  stopPropagation = false,
  className,
  size = 'icon-compact',
  label,
}: RatchetToggleButtonProps) {
  const tooltip = getTooltip(enabled, state);
  const buttonProps = {
    type: 'button',
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (stopPropagation) {
        event.stopPropagation();
      }
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (stopPropagation) {
        event.preventDefault();
        event.stopPropagation();
      }
      onToggle(!enabled);
    },
    disabled,
    pending,
    'aria-pressed': enabled,
  } as const;

  if (label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...buttonProps}
            variant="ghost"
            size="compact"
            aria-label={ACCESSIBLE_NAME}
            className={cn('aria-pressed:bg-accent', className)}
          >
            <RatchetWrenchIcon enabled={enabled} animated={animated} />
            <span>{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <IconButton
      {...buttonProps}
      label={ACCESSIBLE_NAME}
      tooltip={tooltip}
      tooltipSide="top"
      size={size}
      className={className}
    >
      {/* The wrapper fills the button so the processing ring traces its edge. */}
      <RatchetWrenchIcon enabled={enabled} animated={animated} className="size-full" />
    </IconButton>
  );
}
