import { BroomIcon } from '@phosphor-icons/react/dist/csr/Broom';
import { useState } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';

function pluralizeWorktrees(count: number): string {
  return `${count} orphaned worktree${count === 1 ? '' : 's'}`;
}

export function WorktreeCleanupSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: orphans, isLoading } = trpc.admin.listOrphanedWorktrees.useQuery();

  const removeOrphans = trpc.admin.removeOrphanedWorktrees.useMutation({
    onSuccess: ({ removed, failed }) => {
      if (failed.length > 0) {
        toast.error(
          `Removed ${removed.length}; failed to remove ${failed.length}: ${failed[0]?.error}`
        );
      } else {
        toast.success(`Removed ${pluralizeWorktrees(removed.length)}`);
      }
    },
    onError: (error) => {
      toast.error(`Cleanup failed: ${error.message}`);
    },
    onSettled: () => {
      setConfirmOpen(false);
      runInBackground(
        utils.admin.listOrphanedWorktrees.invalidate(),
        'Could not refresh orphaned worktrees'
      );
    },
  });

  const count = orphans?.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BroomIcon className="w-5 h-5" />
          Worktree Cleanup
        </CardTitle>
        <CardDescription>
          Remove worktree folders left behind by archived, deleted, or failed workspaces
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {count === 0
                ? 'No orphaned worktrees found.'
                : `Found ${pluralizeWorktrees(count)} not used by any active workspace.`}
            </p>
            {count > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
                {orphans?.map((orphan) => (
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
              disabled={count === 0 || removeOrphans.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <BroomIcon className="w-4 h-4 mr-2" />
              Remove Orphaned Worktrees
            </Button>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove Orphaned Worktrees"
        description={`Permanently delete ${pluralizeWorktrees(count)}, including any uncommitted files in them. Committed work stays on its branch.`}
        confirmText="Remove"
        variant="destructive"
        isPending={removeOrphans.isPending}
        onConfirm={() => removeOrphans.mutate()}
      />
    </Card>
  );
}
