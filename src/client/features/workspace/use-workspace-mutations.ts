import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';

type RenameWorkspaceMutation = ReturnType<typeof trpc.workspace.rename.useMutation>;
type TriggerAdversarialReviewMutation = ReturnType<
  typeof trpc.adversarialReview.trigger.useMutation
>;

/**
 * Renames a workspace of `projectId`. The mutation stays pending until the
 * workspace detail and the project's list have refetched, so an inline editor
 * can keep the typed name until the new one is on screen.
 */
export function useRenameWorkspace(projectId: string): RenameWorkspaceMutation {
  const utils = trpc.useUtils();
  return trpc.workspace.rename.useMutation({
    onSuccess: (workspace) =>
      Promise.all([
        utils.workspace.get.invalidate({ id: workspace.id }),
        utils.workspace.listForProject.invalidate({ projectId }),
      ]),
    onError: (error) => {
      toast.error("Couldn't rename workspace.", { description: error.message });
    },
  });
}

/** Starts (or reports the already running) adversarial review of a workspace PR. */
export function useTriggerAdversarialReview(workspaceId: string): TriggerAdversarialReviewMutation {
  const utils = trpc.useUtils();
  return trpc.adversarialReview.trigger.useMutation({
    onSuccess: (result) => {
      runInBackground(
        utils.session.listSessions.invalidate({ workspaceId }),
        "Couldn't refresh data."
      );
      toast.success(
        result.status === 'already_active'
          ? 'Adversarial review is already running'
          : 'Adversarial review started'
      );
    },
    onError: (error) => {
      toast.error("Couldn't start adversarial review.", { description: error.message });
    },
  });
}
