import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { getWorkspacePRReviewTarget } from '@/client/lib/workspace-selected-pr';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { isWorkspaceClosed, isWorkspaceMerged } from './utils';

export function AdversarialReviewButton({
  workspace,
  workspaceId,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  renderAsMenuItem?: boolean;
}) {
  const utils = trpc.useUtils();
  const trigger = trpc.adversarialReview.trigger.useMutation({
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

  const { pr: selectedPr, associationId } = getWorkspacePRReviewTarget(workspace);
  if (
    !(workspace.worktreePath && selectedPr?.number) ||
    selectedPr.state === 'NONE' ||
    selectedPr.state === 'MERGED' ||
    selectedPr.state === 'CLOSED' ||
    (!associationId && (isWorkspaceMerged(workspace) || isWorkspaceClosed(workspace)))
  ) {
    return null;
  }
  const startReview = () =>
    trigger.mutate({
      workspaceId,
      ...(associationId ? { prId: associationId } : {}),
    });

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem onSelect={startReview} disabled={trigger.isPending}>
        {trigger.isPending ? (
          <Spinner aria-hidden="true" className="h-4 w-4" />
        ) : (
          <ShieldWarningIcon className="h-4 w-4" />
        )}
        Adversarial review
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 md:h-8 md:w-8"
          aria-label="Start adversarial review"
          disabled={trigger.isPending}
          onClick={startReview}
        >
          {trigger.isPending ? (
            <Spinner aria-hidden="true" className="h-3 w-3 md:h-4 md:w-4" />
          ) : (
            <ShieldWarningIcon className="h-3 w-3 md:h-4 md:w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Adversarial review</TooltipContent>
    </Tooltip>
  );
}
