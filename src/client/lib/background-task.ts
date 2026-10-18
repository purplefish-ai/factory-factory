import { toast } from 'sonner';

/** Own failures from work triggered by synchronous UI or subscription callbacks. */
export function runInBackground(task: Promise<unknown>, errorMessage: string): void {
  void Promise.resolve(task).catch((error: unknown) => {
    toast.error(errorMessage, {
      id: errorMessage,
      description: error instanceof Error ? error.message : undefined,
    });
  });
}
