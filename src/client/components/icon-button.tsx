import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type IconButtonProps = Omit<ComponentProps<typeof Button>, 'size' | 'aria-label' | 'title'> & {
  /** The button's accessible name, also shown as its tooltip. */
  label: string;
  size?: 'icon' | 'icon-xs' | 'icon-compact' | 'icon-sm' | 'icon-lg';
  /** Richer tooltip content, such as a shortcut hint. Defaults to `label`. */
  tooltip?: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
};

/**
 * An icon-only `Button` with a tooltip. The label is both the accessible name
 * and the tooltip, so the two cannot drift apart. It needs a `TooltipProvider`
 * above it; the app layout provides one. It forwards props and its ref to the
 * button, so it also works inside `DropdownMenuTrigger asChild` and similar
 * triggers.
 */
export function IconButton({
  label,
  size = 'icon',
  tooltip,
  tooltipSide,
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size={size} aria-label={label} {...props} />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
