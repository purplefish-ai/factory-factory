import { type ComponentProps, type ReactNode, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  'size' | 'aria-label' | 'aria-labelledby' | 'title'
> & {
  /** The button's accessible name, also shown as its tooltip. */
  label: string;
  size?: 'icon' | 'icon-xs' | 'icon-compact' | 'icon-sm' | 'icon-lg';
  /** Richer tooltip content, such as a shortcut hint. Defaults to `label`. */
  tooltip?: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
  /**
   * Keep the tooltip while the button is disabled or pending. A disabled button
   * receives no pointer events, so the tooltip opens from a wrapper span
   * instead; the wrapper is always rendered so the button keeps focus when it
   * becomes disabled.
   */
  tooltipWhileDisabled?: boolean;
};

/**
 * An icon-only `Button` with a tooltip. The label is both the accessible name
 * and the tooltip, so the two cannot drift apart. It needs a `TooltipProvider`
 * above it; the app layout provides one. It forwards props and its ref to the
 * button, so it also works inside `DropdownMenuTrigger asChild` and similar
 * triggers. A disabled button receives no pointer events, so by default its
 * tooltip shows only while it is enabled; pass `tooltipWhileDisabled` when the
 * tooltip must stay available, for example a shortcut hint on a pending Stop.
 */
export function IconButton({
  label,
  size = 'icon',
  tooltip,
  tooltipSide,
  tooltipWhileDisabled = false,
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  const descriptionId = useId();
  if (!tooltipWhileDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={variant} size={size} aria-label={label} {...props} />
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    );
  }
  // The wrapper is the tooltip trigger, so Radix describes the wrapper. The
  // button carries the tooltip text as its own description for screen readers.
  const describedBy = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant={variant}
            size={size}
            aria-label={label}
            {...props}
            aria-describedby={describedBy}
          />
          <span id={descriptionId} hidden>
            {tooltip ?? label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
