import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { IconButton } from '@/client/components/icon-button';
import { useTriggerAdversarialReview } from '@/client/features/workspace/use-workspace-mutations';
import { getWorkspacePRReviewTarget } from '@/client/lib/workspace-selected-pr';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
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
    <IconButton
      label="Start adversarial review"
      tooltip="Adversarial review"
      size="icon-sm"
      pending={trigger.isPending}
      pendingLabel="Starting adversarial review"
      onClick={startReview}
    >
      <ShieldWarningIcon />
    </IconButton>
  );
}
