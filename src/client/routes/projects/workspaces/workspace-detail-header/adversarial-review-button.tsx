import { ShieldWarningIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { hasVisiblePullRequest, isWorkspaceClosed, isWorkspaceMerged } from './utils';

export function AdversarialReviewButton({
  workspace,
  workspaceId,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
}) {
  const utils = trpc.useUtils();
  const trigger = trpc.adversarialReview.trigger.useMutation({
    onSuccess: (result) => {
      utils.session.listSessions.invalidate({ workspaceId });
      toast.success(
        result.status === 'already_active'
          ? 'Adversarial review is already running'
          : 'Adversarial review started'
      );
    },
    onError: (error) => {
      toast.error(`Failed to start adversarial review: ${error.message}`);
    },
  });

  if (
    !hasVisiblePullRequest(workspace) ||
    isWorkspaceMerged(workspace) ||
    isWorkspaceClosed(workspace)
  ) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 md:h-8 md:w-8"
          disabled={trigger.isPending}
          onClick={() => trigger.mutate({ workspaceId })}
        >
          {trigger.isPending ? (
            <SpinnerGapIcon className="h-3 w-3 animate-spin md:h-4 md:w-4" />
          ) : (
            <ShieldWarningIcon className="h-3 w-3 md:h-4 md:w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Adversarial Review</TooltipContent>
    </Tooltip>
  );
}
