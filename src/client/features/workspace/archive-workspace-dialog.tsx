import { StatusCallout } from '@/client/components/status-callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const defaultDescription =
  'Running agents and processes will stop. Uncommitted changes will be committed before the worktree is removed. Chat history and the branch are kept. Worktree removal cannot be undone in the app.';

/**
 * An archive-incomplete workspace was snapshotted before its first removal
 * attempt, and archiving again deliberately skips the snapshot because the
 * worktree may be partly deleted.
 */
const archiveIncompleteDescription =
  'The last archive of this workspace stopped partway, so its worktree may be partly removed. Archiving again stops anything still running and finishes the removal. Its changes were committed when that archive started, so nothing is committed again. Chat history and the branch are kept.';

export type ArchiveWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  description?: string;
  /** The workspace's last archive did not finish; see `isWorkspaceArchiveIncomplete`. */
  archiveIncomplete?: boolean;
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
  description,
  archiveIncomplete = false,
  activeChildCount = 0,
}: ArchiveWorkspaceDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={archiveIncomplete ? 'Finish archiving workspace?' : 'Archive workspace?'}
      description={
        description ?? (archiveIncomplete ? archiveIncompleteDescription : defaultDescription)
      }
      confirmText={archiveIncomplete ? 'Archive again' : 'Archive'}
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
