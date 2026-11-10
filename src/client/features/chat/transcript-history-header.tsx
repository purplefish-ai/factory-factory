import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { TranscriptHistoryControls } from './use-transcript-history';

export function TranscriptHistoryHeader({ history }: { history: TranscriptHistoryControls }) {
  const [showLoading, setShowLoading] = useState(false);
  const loading = history.status === 'loading';
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    // Opening a short transcript checks for history even when none remains.
    // Avoid inserting and collapsing a status row for these fast requests.
    const timer = setTimeout(() => setShowLoading(true), 250);
    return () => clearTimeout(timer);
  }, [loading]);

  if (!(loading && showLoading) && history.status !== 'error') {
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
          <Button
            variant="link"
            size="inline"
            onClick={history.loadOlder}
            disabled={history.enabled === false}
          >
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
