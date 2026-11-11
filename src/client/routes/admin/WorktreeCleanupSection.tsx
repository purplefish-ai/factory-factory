import { BroomIcon } from '@phosphor-icons/react/dist/csr/Broom';
import { useState } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsSection } from './settings-section';

function pluralizeWorktrees(count: number): string {
  return `${count} orphaned worktree${count === 1 ? '' : 's'}`;
}

export function WorktreeCleanupSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const orphansQuery = trpc.admin.listOrphanedWorktrees.useQuery();

  const removeOrphans = trpc.admin.removeOrphanedWorktrees.useMutation({
    onSuccess: ({ removed, failed }) => {
      if (failed.length > 0) {
        toast.error(
          `Couldn't remove all worktrees. Removed ${removed.length}; failed to remove ${failed.length}. ${failed[0]?.error}`
        );
      } else {
        toast.success(`Removed ${pluralizeWorktrees(removed.length)}`);
      }
    },
    onError: (error) => {
      toast.error(`Couldn't remove orphaned worktrees. ${error.message}`);
    },
    onSettled: () => {
      setConfirmOpen(false);
      runInBackground(
        utils.admin.listOrphanedWorktrees.invalidate(),
        "Couldn't refresh orphaned worktrees."
      );
    },
  });

  const count = orphansQuery.data?.length ?? 0;

  return (
    <>
      <SettingsSection
        title="Worktree cleanup"
        icon={<BroomIcon className="w-5 h-5" />}
        description="Remove worktree folders left behind by archived, deleted, or failed workspaces"
        query={orphansQuery}
        errorTitle="Couldn't scan for orphaned worktrees"
      >
        {(orphans) => (
          <>
            <p className="text-sm text-muted-foreground">
              {orphans.length === 0
                ? 'No orphaned worktrees found.'
                : `Found ${pluralizeWorktrees(orphans.length)} not used by any active workspace.`}
            </p>
            {orphans.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
                {orphans.map((orphan) => (
                  <li key={orphan.path} className="truncate" title={orphan.path}>
                    <span className="text-muted-foreground">{orphan.projectName}:</span>{' '}
                    {orphan.path}
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              disabled={orphans.length === 0 || removeOrphans.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <BroomIcon />
              Remove orphaned worktrees
            </Button>
          </>
        )}
      </SettingsSection>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove orphaned worktrees?"
        description={`Permanently delete ${pluralizeWorktrees(count)}, including any uncommitted files in them. Committed work stays on its branch. Worktree removal cannot be undone.`}
        confirmText="Remove"
        variant="destructive"
        isPending={removeOrphans.isPending}
        onConfirm={() => removeOrphans.mutate()}
      />
    </>
  );
}
