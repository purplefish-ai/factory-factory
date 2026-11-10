import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { getWorkspacePRAssociationId } from '@/client/lib/workspace-selected-pr';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { useTriggerAdversarialReview } from './use-workspace-mutations';
export function useWorkspacePrActions(
  workspaceId: string,
  projectId?: string,
  prs?: readonly WorkspacePullRequest[]
) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.workspace.get.invalidate({ id: workspaceId }),
      ...(projectId ? [utils.workspace.listForProject.invalidate({ projectId })] : []),
    ]);
  };
  const attach = trpc.workspace.attachPR.useMutation({ meta: { errorToast: false } });
  const detach = trpc.workspace.detachPR.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const discard = trpc.workspace.discardBlockedPRDeliveries.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const review = useTriggerAdversarialReview(workspaceId);
  const reviewTarget = (prId: string) => {
    const pr = prs?.find((candidate) => candidate.id === prId);
    return pr ? getWorkspacePRAssociationId(pr) : prId;
  };
  return {
    pending: attach.isPending || detach.isPending || review.isPending || discard.isPending,
    adding: attach.isPending,
    removing: detach.isPending,
    discarding: discard.isPending,
    /** Whether the review in flight is for this PR. */
    isReviewing: (prId: string) =>
      review.isPending && review.variables?.prId === (reviewTarget(prId) ?? undefined),
    add: async (url: string) => {
      try {
        await attach.mutateAsync({ id: workspaceId, prUrl: url });
        await refresh();
        return { success: true as const };
      } catch (error) {
        return {
          success: false as const,
          error: error instanceof Error ? error.message : "Couldn't add PR",
        };
      }
    },
    discardBlocked: async () => {
      try {
        await discard.mutateAsync({ workspaceId });
        return true;
      } catch {
        return false;
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
    review: (prId: string) => {
      const associationId = reviewTarget(prId);
      review.mutate({ workspaceId, ...(associationId !== null ? { prId: associationId } : {}) });
    },
  };
}
