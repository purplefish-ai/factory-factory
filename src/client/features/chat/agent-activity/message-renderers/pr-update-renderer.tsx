import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { PR_UPDATE_QUEUED_TEXT, type PRUpdateDeliveryState } from '@/shared/pr-monitoring';

export function PRUpdateRenderer({
  text,
  queued = false,
  deliveryState,
  error,
}: {
  text: string;
  queued?: boolean;
  deliveryState?: PRUpdateDeliveryState;
  error?: string;
}) {
  const status = deliveryState ?? (queued ? 'queued' : 'delivered');
  const label = status === 'queued' ? 'queued for next turn' : status;
  const body = text.replace(/^<!-- factory-factory-pr-event:[^\n]+ -->\n?/, '');
  const heading = (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <GitPullRequestIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">PR update · {label}</span>
    </span>
  );
  const hasDetails = status !== 'queued' && body !== PR_UPDATE_QUEUED_TEXT;
  return (
    <div className="min-w-0 py-1">
      {hasDetails ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {heading}
            <CaretRightIcon
              className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
          </summary>
          <p className="mt-2 pl-5.5 text-sm whitespace-pre-wrap break-words">{body}</p>
        </details>
      ) : (
        <div role="status">{heading}</div>
      )}
      {error && (
        <p className="mt-1 pl-5.5 text-xs text-destructive" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
