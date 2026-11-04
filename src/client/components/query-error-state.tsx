import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface QueryErrorStateProps {
  /** What failed, e.g. "Couldn't load projects". */
  title: string;
  /** The query error; its message is shown as detail. */
  error?: { message: string } | null;
  onRetry: () => void;
  /** True while a retry is in flight. */
  isRetrying?: boolean;
  className?: string;
}

/**
 * Error branch for a query that has no data to show. Use it instead of an
 * empty state so a backend failure never reads as "nothing here yet".
 */
export function QueryErrorState({
  title,
  error,
  onRetry,
  isRetrying = false,
  className,
}: QueryErrorStateProps) {
  const detail = error?.message.trim();
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center gap-3 p-6 text-center', className)}
    >
      <WarningCircleIcon className="size-8 text-destructive" aria-hidden="true" />
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail ? <p className="break-words text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
        {isRetrying ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : (
          <ArrowClockwiseIcon className="size-3.5" aria-hidden="true" />
        )}
        {isRetrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}
