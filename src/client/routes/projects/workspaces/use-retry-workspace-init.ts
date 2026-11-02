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
        'Could not refresh data'
      );
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const retry = useCallback(() => {
    if (availability?.status !== 'AVAILABLE' || retryInit.isPending) {
      return;
    }
    retryInit.mutate({
      id: workspaceId,
      useExistingBranch: isResumeWorkspace(workspaceId) || undefined,
    });
  }, [retryInit, workspaceId, availability]);

  return { retry, retryInit };
}
