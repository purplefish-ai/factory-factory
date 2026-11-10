import { memo } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface ArchiveGitLockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onRemoveLockAndArchive: () => void;
  workspaceCount?: number;
  /** Archives are still in flight; recovery waits until they settle. */
  isPending?: boolean;
}

export const ArchiveGitLockDialog = memo(function ArchiveGitLockDialog({
  open,
  onOpenChange,
  onRetry,
  onRemoveLockAndArchive,
  workspaceCount = 1,
  isPending = false,
}: ArchiveGitLockDialogProps) {
  const plural = workspaceCount !== 1;

  // Archiving is optimistic: the dialog closes and the board or the archive
  // overlay shows progress. A repeated lock failure reopens it.
  const runAndClose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Git is locked"
      description={`Another Git operation may be running, or an earlier operation may have stopped unexpectedly. Retry without changing the lock, or remove the lock and archive ${plural ? `the ${workspaceCount} affected workspaces` : 'this workspace'}. Remove the lock only if you are sure no other Git operation is running.`}
      confirmText="Remove Lock and Archive"
      variant="destructive"
      onConfirm={() => runAndClose(onRemoveLockAndArchive)}
      secondaryAction={{ label: 'Retry', onClick: () => runAndClose(onRetry) }}
      isPending={isPending}
    />
  );
});
