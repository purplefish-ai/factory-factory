import { toast } from 'sonner';

/** Toast title for a failed background cache refresh, the most common detached task. */
export const REFRESH_FAILED_MESSAGE = "Couldn't refresh data.";

/**
 * Own failures from work triggered by synchronous UI or subscription callbacks.
 * The error message defaults to the refresh failure; pass one for other work.
 */
export function runInBackground(
  task: Promise<unknown>,
  errorMessage: string = REFRESH_FAILED_MESSAGE
): void {
  void Promise.resolve(task).catch((error: unknown) => {
    toast.error(errorMessage, {
      id: errorMessage,
      description: error instanceof Error ? error.message : undefined,
    });
  });
}
