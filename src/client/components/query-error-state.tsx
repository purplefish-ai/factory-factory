import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { StatusCallout } from '@/client/components/status-callout';
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
  /** Applied to the area the error replaces, e.g. `h-full` or padding. */
  className?: string;
}

/**
 * Error branch for a query that has no data to show: a danger callout centered
 * in the space the content would fill. Use it instead of an empty state so a
 * backend failure never reads as "nothing here yet".
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
    <div className={cn('flex items-center justify-center p-6', className)}>
      <StatusCallout
        role="alert"
        tone="danger"
        title={title}
        className="w-full max-w-md"
        action={
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
        }
      >
        {detail || undefined}
      </StatusCallout>
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
 * background refetch failed: a danger strip above the content. It sits in
 * normal flow, so the content keeps its state; place it inside a `flex-col`
 * parent and give fixed-height content `min-h-0 flex-1`.
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
    <StatusCallout
      role="status"
      aria-live="polite"
      tone="danger"
      variant="strip"
      size="sm"
      className={cn('shrink-0', className)}
      title={
        <p>
          {title}. <span className="font-normal">Showing the last loaded data.</span>
        </p>
      }
      action={
        <Button
          variant="ghost"
          size="xs"
          onClick={onRetry}
          pending={isRetrying}
          pendingLabel="Retrying…"
        >
          Retry
        </Button>
      }
    >
      {detail || undefined}
    </StatusCallout>
  );
}
