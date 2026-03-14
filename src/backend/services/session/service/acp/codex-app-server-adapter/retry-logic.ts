import { CodexRequestError } from './codex-rpc-client';

const OVERLOAD_ERROR_CODE = -32_001;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

export const MAX_CLOSE_WATCHER_ATTACH_RETRIES = 50;

type AttachCloseWatcherWithRetryParams = {
  getClosed: () => Promise<void>;
  onClose: () => Promise<void>;
  onAttachRetryLimitReached: (maxAttempts: number) => void;
  maxAttachRetries?: number;
};

export function attachCloseWatcherWithRetry(params: AttachCloseWatcherWithRetryParams): void {
  const maxAttachRetries = params.maxAttachRetries ?? MAX_CLOSE_WATCHER_ATTACH_RETRIES;
  let attachAttempts = 0;

  const attachCloseWatcher = () => {
    try {
      void params
        .getClosed()
        .finally(async () => {
          await params.onClose();
        })
        .catch(() => {
          // Ignore close-watcher errors and still attempt subprocess shutdown.
        });
    } catch {
      attachAttempts += 1;
      if (attachAttempts >= maxAttachRetries) {
        params.onAttachRetryLimitReached(maxAttachRetries);
        return;
      }
      const retryTimer = setTimeout(attachCloseWatcher, 0);
      retryTimer.unref?.();
    }
  };

  queueMicrotask(attachCloseWatcher);
}

type RequestWithOverloadRetryParams<T> = {
  request: () => Promise<unknown>;
  parse: (raw: unknown) => T;
  maxAttempts?: number;
};

export async function requestWithOverloadRetry<T>(
  params: RequestWithOverloadRetryParams<T>
): Promise<T> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const raw = await params.request();
      return params.parse(raw);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof CodexRequestError) ||
        error.code !== OVERLOAD_ERROR_CODE ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      const delayMs = Math.round(2 ** attempt * 100 + Math.random() * 120);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
