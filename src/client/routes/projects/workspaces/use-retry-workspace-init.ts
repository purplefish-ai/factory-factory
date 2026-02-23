import { useCallback } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { isResumeWorkspace } from './resume-workspace-storage';

interface UseRetryWorkspaceInitResult {
  retry: () => void;
  retryInit: ReturnType<typeof trpc.workspace.retryInit.useMutation>;
}

export function useRetryWorkspaceInit(workspaceId: string): UseRetryWorkspaceInitResult {
  const utils = trpc.useUtils();
  const retryInit = trpc.workspace.retryInit.useMutation({
    onSuccess: () => {
      utils.workspace.getInitStatus.invalidate({ id: workspaceId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const retry = useCallback(() => {
    retryInit.mutate({
      id: workspaceId,
      useExistingBranch: isResumeWorkspace(workspaceId) || undefined,
    });
  }, [retryInit, workspaceId]);

  return { retry, retryInit };
}
