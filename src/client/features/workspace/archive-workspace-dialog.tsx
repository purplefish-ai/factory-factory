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
import { buttonVariants } from '@/components/ui/button';

const defaultDescription =
  'Any uncommitted changes will be committed before the worktree is removed.';

export type ArchiveWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  description?: string;
  /** Number of active (non-archived) child workspaces */
  activeChildCount?: number;
};

export function ArchiveWorkspaceDialog({
  open,
  onOpenChange,
  onConfirm,
  description = defaultDescription,
  activeChildCount = 0,
}: ArchiveWorkspaceDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Workspace</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {activeChildCount > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              This workspace has {activeChildCount} active child workspace
              {activeChildCount !== 1 ? 's' : ''}. Archiving will not automatically archive them.
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onConfirm();
              onOpenChange(false);
            }}
            className={buttonVariants({ variant: 'destructive' })}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
