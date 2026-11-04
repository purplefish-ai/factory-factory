import { Spinner } from '@/components/ui/spinner';
import type { TranscriptHistoryControls } from './use-transcript-history';

export function TranscriptHistoryHeader({ history }: { history: TranscriptHistoryControls }) {
  if (history.status !== 'loading' && history.status !== 'error') {
    return null;
  }
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
      ) : (
        <>
          <span>{history.error || 'Could not load earlier messages.'}</span>
          <button
            type="button"
            onClick={history.loadOlder}
            disabled={history.enabled === false}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
