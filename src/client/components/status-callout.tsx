import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from 'react';
import { StatusIcon } from '@/client/components/status-indicators';
import { getStatusToneStyle, type StatusTone } from '@/client/lib/status-tones';
import { cn } from '@/lib/utils';

export interface StatusCalloutProps extends Omit<ComponentProps<'div'>, 'title'> {
  tone: StatusTone;
  /**
   * The tone's icon by default. Pass a Phosphor icon to replace it, an element
   * (such as a `Spinner`) to render it as is, or `false` for none.
   */
  icon?: boolean | Icon | ReactElement;
  /** Medium-weight first line; may be a heading element. */
  title?: ReactNode;
  /**
   * The message, under the title. All callout text uses the tone color, which
   * the palette test keeps legible on every tint; the foreground color is not.
   */
  children?: ReactNode;
  /**
   * Compact controls at the trailing edge, such as Retry or Dismiss; they wrap
   * under the message in narrow containers. A row of primary actions belongs
   * in the body instead.
   */
  action?: ReactNode;
  /**
   * `card` is a rounded, bordered box in a list or form. `strip` spans the top
   * of a pane or panel with only a bottom border.
   */
  variant?: 'card' | 'strip';
  /** `sm` uses extra-small text for dense panels; `md` uses small text. */
  size?: 'sm' | 'md';
}

/**
 * The one status callout: a tinted surface from the tone map
 * (`getStatusToneStyle(tone).surface`) with an icon, title, message and
 * action. Use it for every error, warning, success or info message box rather
 * than pairing status background and border classes by hand
 * (factory/use-status-callout; docs/status-colors.md).
 *
 * Pass `role="alert"` for an error that appears in response to an action, or
 * `role="status"` for a polite live update; static callouts need no role.
 */
export function StatusCallout({
  tone,
  icon = true,
  title,
  children,
  action,
  variant = 'card',
  size = 'md',
  className,
  ...props
}: StatusCalloutProps) {
  const hasTitle = title !== undefined && title !== null && title !== false;
  return (
    <div
      {...props}
      data-status-tone={tone}
      data-slot="status-callout"
      className={cn(
        // Actions wrap under the message once it would be narrower than 12rem.
        'flex flex-wrap items-center gap-x-2 gap-y-1.5 border',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        variant === 'card' ? 'rounded-md' : 'rounded-none border-x-0 border-t-0',
        getStatusToneStyle(tone).surface,
        className
      )}
    >
      <CalloutIcon tone={tone} icon={icon} size={size} />
      <div className="min-w-0 flex-1 basis-48 break-words">
        {hasTitle ? <div className="font-medium">{title}</div> : null}
        {children !== undefined && children !== null && children !== false ? (
          <div className={cn(hasTitle && 'mt-0.5')}>{children}</div>
        ) : null}
      </div>
      {action ? (
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function CalloutIcon({
  tone,
  icon,
  size,
}: {
  tone: StatusTone;
  icon: NonNullable<StatusCalloutProps['icon']>;
  size: NonNullable<StatusCalloutProps['size']>;
}) {
  if (icon === false) {
    return null;
  }
  // Let the row center icons, text and controls regardless of button height.
  const position = size === 'sm' ? 'size-3.5' : 'size-4';
  if (isValidElement(icon)) {
    return <span className={cn('flex shrink-0 items-center', position)}>{icon}</span>;
  }
  return <StatusIcon tone={tone} icon={icon === true ? undefined : icon} className={position} />;
}
