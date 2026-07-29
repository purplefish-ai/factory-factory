import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';

export interface ArchiveGitLockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onRemoveLockAndArchive: () => void;
  workspaceCount?: number;
  isPending?: boolean;
}

export function ArchiveGitLockDialog({
  open,
  onOpenChange,
  onRetry,
  onRemoveLockAndArchive,
  workspaceCount = 1,
  isPending = false,
}: ArchiveGitLockDialogProps) {
  const plural = workspaceCount !== 1;

  const runAndClose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Git is locked</AlertDialogTitle>
          <AlertDialogDescription>
            Another Git operation may be running, or an earlier operation may have stopped
            unexpectedly. Retry without changing the lock, or remove the lock and archive
            {plural ? ` the ${workspaceCount} affected workspaces` : ' this workspace'}. Remove the
            lock only if you are sure no other Git operation is running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => runAndClose(onRetry)}
          >
            Retry
          </Button>
          <AlertDialogAction
            disabled={isPending}
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(event) => {
              event.preventDefault();
              runAndClose(onRemoveLockAndArchive);
            }}
          >
            Remove Lock and Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
