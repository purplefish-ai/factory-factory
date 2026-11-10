import { toast } from 'sonner';

export const CHUNK_LOAD_ERROR_TOAST_ID = 'chunk-load-error';

/**
 * Offers a reload when Vite fails to load a lazy chunk, which usually means
 * the app was updated after this page loaded. The error still rejects the
 * import, so the nearest `ErrorBoundary` replaces only the part that failed.
 */
export function installChunkLoadRecovery(target: Window = window): () => void {
  const handleChunkLoadError = () => {
    toast.error("Couldn't load part of the app", {
      id: CHUNK_LOAD_ERROR_TOAST_ID,
      description: 'Factory Factory may have been updated. Reload to get the latest version.',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Reload', onClick: () => target.location.reload() },
    });
  };
  target.addEventListener('vite:preloadError', handleChunkLoadError);
  return () => target.removeEventListener('vite:preloadError', handleChunkLoadError);
}
