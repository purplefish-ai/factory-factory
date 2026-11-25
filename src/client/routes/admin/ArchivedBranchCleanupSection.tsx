import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryState } from '@/client/components/query-state';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ArchivedRefCleanup } from './ArchivedRefCleanup';
import { SettingsSection } from './settings-section';

function pluralizeBranches(count: number): string {
  return `${count} branch${count === 1 ? '' : 'es'}`;
}

const SAFETY_LABEL = { ON_REMOTE: 'on a remote', MERGED_PR: 'PR merged' } as const;

function ArchivedBranchCleanup() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const candidatesQuery = trpc.admin.listArchivedBranchCandidates.useQuery();

  const removeBranches = trpc.admin.removeArchivedBranches.useMutation({
    onSuccess: ({ removed, skipped, failed }) => {
      const skippedNote =
        skipped.length > 0 ? ` Skipped ${skipped.length} that changed or no longer qualify.` : '';
      if (failed.length > 0) {
        toast.error(
          `Couldn't delete all branches. Deleted ${removed.length}; failed to delete ${failed.length}.${skippedNote} ${failed[0]?.error}`
        );
      } else {
        toast.success(`Deleted ${pluralizeBranches(removed.length)}.${skippedNote}`);
      }
    },
    onError: (error) => {
      toast.error(`Couldn't delete branches. ${error.message}`);
    },
    onSettled: () => {
      setConfirmOpen(false);
      runInBackground(
        utils.admin.listArchivedBranchCandidates.invalidate(),
        "Couldn't refresh archived workspace branches."
      );
      // Each deleted branch leaves a pin, listed with the snapshots.
      runInBackground(
        utils.admin.listArchivedRefCandidates.invalidate(),
        "Couldn't refresh archive snapshots."
      );
    },
  });

  const groups = candidatesQuery.data ?? [];
  const requests = groups.flatMap((group) =>
    group.branches.map((branch) => ({
      projectId: group.projectId,
      name: branch.name,
      sha: branch.sha,
    }))
  );
  const count = requests.length;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Branches</h3>
        <p className="text-sm text-muted-foreground">
          Local branches that only archived workspaces used, once their commits are on a remote or
          in a merged PR.
        </p>
      </div>
      <QueryState
        query={candidatesQuery}
        errorTitle="Couldn't scan for archived workspace branches"
        loading={<Skeleton className="h-10 w-full" />}
        refreshErrorClassName="rounded-md border"
      >
        {() => (
          <>
            <p className="text-sm text-muted-foreground">
              {count === 0
                ? 'No archived workspace branches to delete.'
                : `Found ${pluralizeBranches(count)} from archived workspaces.`}
            </p>
            {groups.map((group) => (
              <div key={group.projectId} className="space-y-1">
                <p className="text-sm font-medium" title={group.repoPath}>
                  {group.projectNames.join(', ')}{' '}
                  <span className="font-normal text-muted-foreground">
                    ({pluralizeBranches(group.branches.length)})
                  </span>
                </p>
                <ul className="max-h-40 overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
                  {group.branches.map((branch) => (
                    <li key={branch.name} className="truncate" title={branch.name}>
                      {branch.name}{' '}
                      <span className="text-muted-foreground">
                        ({SAFETY_LABEL[branch.safeBecause]})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              disabled={count === 0 || removeBranches.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <GitBranchIcon />
              {count === 0 ? 'Delete branches' : `Delete ${pluralizeBranches(count)}`}
            </Button>
          </>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${pluralizeBranches(count)}?`}
        description={`Delete ${pluralizeBranches(count)} from this computer. Remote branches are not changed. Each deleted branch's last commit is kept under refs/factory-factory/deleted-branches/, so Git can recreate it. A branch that changed since this list loaded is skipped.`}
        confirmText="Delete"
        variant="destructive"
        isPending={removeBranches.isPending}
        onConfirm={() => removeBranches.mutate({ branches: requests })}
      />
    </div>
  );
}

/** Branches, archive snapshots and deleted-branch pins that archived workspaces left behind. */
export function ArchivedBranchCleanupSection() {
  return (
    <SettingsSection
      title="Branch and snapshot cleanup"
      icon={<GitBranchIcon className="w-5 h-5" />}
      description="Delete what archived workspaces leave behind in project repositories. Nothing is deleted without confirmation."
    >
      <ArchivedBranchCleanup />
      <Separator />
      <ArchivedRefCleanup />
    </SettingsSection>
  );
}
