import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { useTriggerAdversarialReview } from '@/client/features/workspace/use-workspace-mutations';
import { getWorkspacePRReviewTarget } from '@/client/lib/workspace-selected-pr';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
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
  const trigger = useTriggerAdversarialReview(workspaceId);

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
      <DropdownMenuItem onSelect={startReview} pending={trigger.isPending}>
        <ShieldWarningIcon className="h-4 w-4" />
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
          pending={trigger.isPending}
          pendingLabel="Starting adversarial review"
          onClick={startReview}
        >
          <ShieldWarningIcon className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Adversarial review</TooltipContent>
    </Tooltip>
  );
}
