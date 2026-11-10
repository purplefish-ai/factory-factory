import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from '@/components/ui/button';
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
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        pending={isRetrying}
        pendingLabel="Retrying…"
      >
        <ArrowClockwiseIcon className="size-3.5" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

interface QueryRefreshErrorProps {
  /** What failed to refresh, e.g. "Couldn't refresh workspaces". */
  title?: string;
  error: { message: string };
  onRetry: () => void;
  isRetrying?: boolean;
  className?: string;
}

/**
 * Non-blocking notice for a query whose cached data is still shown after a
 * background refetch failed. It sits above the content in normal flow, so the
 * content keeps its state; place it inside a `flex-col` parent and give
 * fixed-height content `min-h-0 flex-1`.
 */
export function QueryRefreshError({
  title = "Couldn't refresh",
  error,
  onRetry,
  isRetrying = false,
  className,
}: QueryRefreshErrorProps) {
  const detail = error.message.trim();
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-2 border-b bg-destructive/5 px-3 py-1 text-xs',
        className
      )}
    >
      <WarningCircleIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium text-foreground">{title}.</span>{' '}
          <span className="text-muted-foreground">Showing the last loaded data.</span>
        </p>
        {detail ? <p className="break-words text-muted-foreground">{detail}</p> : null}
      </div>
      <Button
        variant="ghost"
        size="xs"
        onClick={onRetry}
        pending={isRetrying}
        pendingLabel="Retrying…"
      >
        Retry
      </Button>
    </div>
  );
}
