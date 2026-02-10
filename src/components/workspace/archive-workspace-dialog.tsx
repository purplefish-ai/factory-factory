import { useEffect, useState } from 'react';

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
import { Checkbox } from '@/components/ui/checkbox';

const defaultDescription = 'Archiving will remove the workspace worktree from disk.';
const defaultWarning =
  'Warning: This workspace has uncommitted changes and they will be committed before archiving.';
const defaultLabel = 'Commit uncommitted changes before archiving';

export type ArchiveWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasUncommitted: boolean;
  onConfirm: (commitUncommitted: boolean) => void;
  description?: string;
  warningText?: string;
  checkboxLabel?: string;
};

export function ArchiveWorkspaceDialog({
  open,
  onOpenChange,
  hasUncommitted,
  onConfirm,
  description = defaultDescription,
  warningText = defaultWarning,
  checkboxLabel = defaultLabel,
}: ArchiveWorkspaceDialogProps) {
  const [commitChangesChecked, setCommitChangesChecked] = useState(true);

  useEffect(() => {
    if (open) {
      setCommitChangesChecked(true);
    }
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Workspace</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {hasUncommitted && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {warningText}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={commitChangesChecked}
              onCheckedChange={(checked) => setCommitChangesChecked(checked === true)}
            />
            {checkboxLabel}
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm(commitChangesChecked);
              onOpenChange(false);
            }}
            disabled={hasUncommitted && !commitChangesChecked}
            className={buttonVariants({ variant: 'destructive' })}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
