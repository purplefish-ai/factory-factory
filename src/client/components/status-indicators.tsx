import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import type { ComponentProps, ReactNode } from 'react';
import { getStatusToneStyle, type StatusTone } from '@/client/lib/status-tones';
import { cn } from '@/lib/utils';

const DOT_SIZES = { xs: 'h-1.5 w-1.5', sm: 'h-2 w-2', md: 'h-2.5 w-2.5' } as const;

interface StatusDotProps {
  tone: StatusTone;
  /** Overrides the tone's default animation (only `working` pulses by default). */
  pulse?: boolean;
  /** `xs` (6px) sits beside small text, e.g. in tabs and log banners. */
  size?: keyof typeof DOT_SIZES;
  /** Accessible name; omit when adjacent text already names the status. */
  label?: string;
  className?: string;
}

/** A small filled dot in the tone's color. */
export function StatusDot({ tone, pulse, size = 'sm', label, className }: StatusDotProps) {
  const style = getStatusToneStyle(tone);
  const dotClassName = cn(
    'inline-block shrink-0 rounded-full',
    DOT_SIZES[size],
    style.dot,
    (pulse ?? style.pulse) && 'animate-pulse motion-reduce:animate-none',
    className
  );
  if (label) {
    return (
      <span
        data-status-tone={tone}
        role="img"
        aria-label={label}
        title={label}
        className={dotClassName}
      />
    );
  }
  return <span data-status-tone={tone} aria-hidden="true" className={dotClassName} />;
}

interface StatusIconProps {
  tone: StatusTone;
  /** Replaces the tone's default icon with a more specific one. */
  icon?: Icon;
  pulse?: boolean;
  className?: string;
}

/** The tone's icon (or a specific one) in the tone's color. */
export function StatusIcon({ tone, icon, pulse, className }: StatusIconProps) {
  const style = getStatusToneStyle(tone);
  const IconComponent = icon ?? style.icon;
  return (
    <IconComponent
      aria-hidden="true"
      data-status-tone={tone}
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        style.text,
        (pulse ?? style.pulse) && 'animate-pulse motion-reduce:animate-none',
        className
      )}
    />
  );
}

interface StatusChipProps extends ComponentProps<'span'> {
  tone: StatusTone;
  children: ReactNode;
  /** Show the tone's icon (`true`) or a specific icon before the label. */
  icon?: boolean | Icon;
  size?: 'sm' | 'md';
}

/**
 * The one tinted status label, on cards, list rows and PR panels. Counts use
 * `Badge size="count"`; messages use `StatusCallout`.
 */
export function StatusChip({
  tone,
  children,
  icon = false,
  size = 'sm',
  className,
  ...props
}: StatusChipProps) {
  const style = getStatusToneStyle(tone);
  const ChipIcon = icon === true ? style.icon : icon || null;
  return (
    <span
      {...props}
      data-status-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-xs',
        style.chip,
        className
      )}
    >
      {ChipIcon && (
        <ChipIcon aria-hidden="true" className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      )}
      {children}
    </span>
  );
}
