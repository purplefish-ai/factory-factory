import { useCallback } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';
import { isResumeWorkspace } from './resume-workspace-storage';

interface UseRetryWorkspaceInitResult {
  retry: () => void;
  retryInit: ReturnType<typeof trpc.workspace.retryInit.useMutation>;
}

export function useRetryWorkspaceInit(
  workspaceId: string,
  availability?: WorkspaceRetryAvailability
): UseRetryWorkspaceInitResult {
  const utils = trpc.useUtils();
  const retryInit = trpc.workspace.retryInit.useMutation({
    onSettled: () => {
      runInBackground(
        utils.workspace.getInitStatus.invalidate({ id: workspaceId }),
        "Couldn't refresh data."
      );
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // The mutation result is a new object every render; depend on its stable
  // `mutate` so the retry handler keeps its identity for memoized banners.
  const { mutate, isPending } = retryInit;
  const retry = useCallback(() => {
    if (availability?.status !== 'AVAILABLE' || isPending) {
      return;
    }
    mutate({
      id: workspaceId,
      useExistingBranch: isResumeWorkspace(workspaceId) || undefined,
    });
  }, [mutate, isPending, workspaceId, availability]);

  return { retry, retryInit };
}
