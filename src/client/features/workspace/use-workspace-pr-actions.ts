import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
export function useWorkspacePrActions(workspaceId: string, projectId?: string) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.workspace.get.invalidate({ id: workspaceId }),
      ...(projectId ? [utils.workspace.listForProject.invalidate({ projectId })] : []),
    ]);
  };
  const attach = trpc.workspace.attachPR.useMutation();
  const detach = trpc.workspace.detachPR.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const review = trpc.adversarialReview.trigger.useMutation({
    onSuccess: () => {
      void utils.session.listSessions.invalidate({ workspaceId });
      toast.success('Review started');
    },
    onError: (error) => toast.error(error.message),
  });
  return {
    pending: attach.isPending || detach.isPending || review.isPending,
    add: async (url: string) => {
      try {
        await attach.mutateAsync({ id: workspaceId, prUrl: url });
        await refresh();
        return { success: true as const };
      } catch (error) {
        return {
          success: false as const,
          error: error instanceof Error ? error.message : 'Could not add PR',
        };
      }
    },
    remove: async (prId: string) => {
      try {
        await detach.mutateAsync({ workspaceId, prId });
        return true;
      } catch {
        return false;
      }
    },
    review: (prId: string) => review.mutate({ workspaceId, prId }),
  };
}
