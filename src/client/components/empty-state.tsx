import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EmptyStateSize = 'default' | 'compact';

export interface EmptyStateProps {
  /** Phosphor icon shown above the title. Omit for text-only empty states. */
  icon?: Icon;
  /** Overrides the muted icon color, e.g. `text-warning` for a cautionary empty state. */
  iconClassName?: string;
  /** One line that names what is missing, e.g. "No screenshots yet". No trailing period. */
  title: ReactNode;
  /** Optional sentence that explains why or what to do next. */
  description?: ReactNode;
  /** The next step, usually one outline `Button` that creates the missing thing. */
  action?: ReactNode;
  /** `compact` fits narrow side panels and lists; `default` suits main panes and pages. */
  size?: EmptyStateSize;
  /** Extra content under the description, such as keyboard hints. */
  children?: ReactNode;
  className?: string;
}

const SIZE_STYLES: Record<
  EmptyStateSize,
  { root: string; icon: string; title: string; description: string }
> = {
  default: {
    root: 'gap-3 p-6',
    icon: 'size-8',
    title: 'text-sm',
    description: 'text-sm',
  },
  compact: {
    root: 'gap-2 p-4',
    icon: 'size-6',
    title: 'text-sm',
    description: 'text-xs',
  },
};

/**
 * Shared "nothing here" state. Pair it with the action that fills the space
 * when one exists, and never render it for a failed query (use
 * `QueryErrorState` or `QueryState`).
 */
export function EmptyState({
  icon: IconComponent,
  iconClassName,
  title,
  description,
  action,
  size = 'default',
  children,
  className,
}: EmptyStateProps) {
  const styles = SIZE_STYLES[size];
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        styles.root,
        className
      )}
    >
      {IconComponent ? (
        <IconComponent
          className={cn('text-muted-foreground', styles.icon, iconClassName)}
          aria-hidden="true"
        />
      ) : null}
      <div className="max-w-sm space-y-1">
        <p className={cn('font-medium text-foreground', styles.title)}>{title}</p>
        {description !== undefined && description !== null ? (
          <p className={cn('text-muted-foreground', styles.description)}>{description}</p>
        ) : null}
      </div>
      {children}
      {action !== undefined && action !== null ? (
        <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
