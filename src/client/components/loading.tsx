import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface LoadingProps {
  /** What is loading, e.g. "Loading workspace…". */
  message?: string;
  /** `compact` drops the minimum height for side panels and small containers. */
  size?: 'default' | 'compact';
  className?: string;
}

/**
 * Route- or panel-level wait with no known layout. Prefer `Skeleton` when the
 * shape of the content is known, and `Spinner` for inline or button pending.
 */
export function Loading({ message = 'Loading…', size = 'default', className }: LoadingProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex h-full flex-col items-center justify-center text-muted-foreground',
        size === 'default' ? 'min-h-[200px] gap-3' : 'gap-2 p-4',
        className
      )}
    >
      <Spinner className={size === 'default' ? 'size-6' : 'size-5'} aria-hidden="true" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
