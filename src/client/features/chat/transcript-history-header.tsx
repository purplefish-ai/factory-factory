import { Spinner } from '@/components/ui/spinner';
import type { TranscriptHistoryControls } from './use-transcript-history';

export function TranscriptHistoryHeader({ history }: { history: TranscriptHistoryControls }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground"
    >
      {history.status === 'loading' ? (
        <>
          <Spinner aria-hidden="true" />
          Loading earlier messages…
        </>
      ) : history.status === 'complete' ? (
        'Beginning of conversation'
      ) : history.status === 'error' ? (
        <>
          <span>{history.error || 'Could not load earlier messages.'}</span>
          <button
            type="button"
            onClick={history.loadOlder}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </>
      ) : (
        <button type="button" onClick={history.loadOlder} className="underline underline-offset-2">
          Load earlier messages
        </button>
      )}
    </div>
  );
}
