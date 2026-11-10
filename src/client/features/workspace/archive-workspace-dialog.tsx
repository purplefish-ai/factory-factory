import { StatusCallout } from '@/client/components/status-callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const defaultDescription =
  'Running agents and processes will stop. Uncommitted changes will be committed before the worktree is removed. Chat history and the branch are kept. Worktree removal cannot be undone in the app.';

export type ArchiveWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  description?: string;
  /** Number of active (non-archived) child workspaces */
  activeChildCount?: number;
};

/**
 * Archiving is optimistic: confirming closes the dialog at once and the
 * workspace leaves the board (or the archive overlay covers it) while the
 * archive runs.
 */
export function ArchiveWorkspaceDialog({
  open,
  onOpenChange,
  onConfirm,
  description = defaultDescription,
  activeChildCount = 0,
}: ArchiveWorkspaceDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Archive workspace?"
      description={description}
      confirmText="Archive"
      variant="destructive"
      onConfirm={() => {
        onConfirm();
        onOpenChange(false);
      }}
    >
      {activeChildCount > 0 && (
        <StatusCallout tone="warning">
          This workspace has {activeChildCount} active child workspace
          {activeChildCount !== 1 ? 's' : ''}. Archiving will not automatically archive them.
        </StatusCallout>
      )}
    </ConfirmDialog>
  );
}
