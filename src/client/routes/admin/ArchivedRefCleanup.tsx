import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import type { inferRouterOutputs } from '@trpc/server';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { QueryState } from '@/client/components/query-state';
import { runInBackground } from '@/client/lib/background-task';
import { formatDate } from '@/client/lib/date-time';
import { type AppRouter, trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

type Group = inferRouterOutputs<AppRouter>['admin']['listArchivedRefCandidates'][number];
type Candidate = Group['refs'][number];
type Tier = Candidate['tier'];

/** The `admin.removeArchivedRefs` input limit. */
export const MAX_REFS_PER_REQUEST = 10_000;

interface Entry {
  key: string;
  projectId: string;
  candidate: Candidate;
}

function pluralizeSnapshots(count: number): string {
  return `${count.toLocaleString()} snapshot${count === 1 ? '' : 's'}`;
}

function pluralizeCommits(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

/** What a ref keeps, in words: a workspace's archive snapshot or a deleted branch's tip. */
function describeRef(candidate: Candidate): string {
  if (candidate.kind === 'DELETED_BRANCH') {
    return `Deleted branch ${candidate.branchName ?? candidate.ref}`;
  }
  return candidate.workspaceName
    ? `Snapshot of ${candidate.workspaceName}`
    : `Snapshot of deleted workspace ${candidate.workspaceId ?? candidate.ref}`;
}

function entriesOf(groups: Group[], tier: Tier): Array<{ group: Group; entries: Entry[] }> {
  return groups.flatMap((group) => {
    const entries = group.refs
      .filter((candidate) => candidate.tier === tier)
      .map((candidate) => ({
        // The commit is part of the key, so a ref that moved is never preselected.
        key: `${group.projectId}\0${candidate.ref}\0${candidate.sha}`,
        projectId: group.projectId,
        candidate,
      }));
    return entries.length > 0 ? [{ group, entries }] : [];
  });
}

function GroupHeading({ group, count }: { group: Group; count: number }) {
  return (
    <p className="text-sm font-medium" title={group.repoPath}>
      {group.projectNames.join(', ')}{' '}
      <span className="font-normal text-muted-foreground">({pluralizeSnapshots(count)})</span>
    </p>
  );
}

function RedundantList({
  groups,
  selected,
  onSelectedChange,
}: {
  groups: Array<{ group: Group; entries: Entry[] }>;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
}) {
  const id = useId();
  const count = groups.reduce((total, { entries }) => total + entries.length, 0);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          className="mt-0.5"
        />
        <Label htmlFor={id} className="block font-normal leading-snug">
          {`Delete ${pluralizeSnapshots(count)} whose commits are on a branch or remote`}
          <span className="block text-xs text-muted-foreground">Nothing is lost.</span>
        </Label>
      </div>
      {groups.map(({ group, entries }) => (
        <div key={group.projectId} className="space-y-1">
          <GroupHeading group={group} count={entries.length} />
          <ul className="max-h-40 overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
            {entries.map(({ key, candidate }) => (
              <li key={key} className="truncate" title={candidate.ref}>
                {describeRef(candidate)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UniqueWorkList({
  groups,
  selectedKeys,
  onToggle,
  onSelectAll,
}: {
  groups: Array<{ group: Group; entries: Entry[] }>;
  selectedKeys: ReadonlySet<string>;
  onToggle: (key: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
}) {
  const id = useId();
  const all = groups.flatMap(({ entries }) => entries);
  const selectedCount = all.filter(({ key }) => selectedKeys.has(key)).length;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {`${pluralizeSnapshots(all.length)} holding work found nowhere else`}
      </p>
      <div className="flex items-start gap-2 rounded-md border border-destructive/50 p-2 text-sm text-destructive">
        <WarningIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          No branch or remote has these commits. Once a snapshot is deleted and Git
          garbage-collects, its work cannot be recovered. Only snapshots older than 30 days are
          listed, and none is selected until you choose it.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selectedCount === all.length}
          onClick={() => onSelectAll(true)}
        >
          Select all
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selectedCount === 0}
          onClick={() => onSelectAll(false)}
        >
          Clear
        </Button>
      </div>
      {groups.map(({ group, entries }) => (
        <div key={group.projectId} className="space-y-1">
          <GroupHeading group={group} count={entries.length} />
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border bg-muted/50 p-2 text-xs">
            {entries.map(({ key, candidate }, index) => (
              <li key={key} className="flex items-start gap-2" title={candidate.ref}>
                <Checkbox
                  id={`${id}-${group.projectId}-${index}`}
                  checked={selectedKeys.has(key)}
                  onCheckedChange={(checked) => onToggle(key, checked === true)}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`${id}-${group.projectId}-${index}`}
                  className="block min-w-0 text-xs font-normal leading-snug"
                >
                  <span className="block truncate font-mono">{describeRef(candidate)}</span>
                  <span className="block text-muted-foreground">
                    {`${pluralizeCommits(candidate.unsharedCommits)} found nowhere else · ${formatDate(candidate.datedAt)}`}
                  </span>
                </Label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ArchivedRefLists({ groups }: { groups: Group[] }) {
  const [includeRedundant, setIncludeRedundant] = useState(true);
  const [selectedUnique, setSelectedUnique] = useState<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();

  const removeRefs = trpc.admin.removeArchivedRefs.useMutation({
    onSuccess: ({ removed, skipped, failed }) => {
      const skippedNote =
        skipped.length > 0 ? ` Skipped ${skipped.length} that changed or no longer qualify.` : '';
      if (failed.length > 0) {
        toast.error(
          `Couldn't delete all snapshots. Deleted ${removed.length}; failed to delete ${failed.length}.${skippedNote}`,
          { description: failed[0]?.error }
        );
      } else {
        toast.success(`Deleted ${pluralizeSnapshots(removed.length)}.${skippedNote}`);
      }
    },
    onError: (error) => {
      toast.error("Couldn't delete snapshots.", { description: error.message });
    },
    onSettled: () => {
      setConfirmOpen(false);
      setSelectedUnique(new Set());
      runInBackground(
        utils.admin.listArchivedRefCandidates.invalidate(),
        "Couldn't refresh archive snapshots."
      );
    },
  });

  const redundant = entriesOf(groups, 'REDUNDANT');
  const unique = entriesOf(groups, 'UNIQUE_WORK');
  const toRequest = (tier: Tier) => (entry: Entry) => ({
    projectId: entry.projectId,
    ref: entry.candidate.ref,
    sha: entry.candidate.sha,
    tier,
  });
  const redundantRequests = includeRedundant
    ? redundant.flatMap(({ entries }) => entries.map(toRequest('REDUNDANT')))
    : [];
  const uniqueRequests = unique.flatMap(({ entries }) =>
    entries.filter(({ key }) => selectedUnique.has(key)).map(toRequest('UNIQUE_WORK'))
  );
  // One request carries at most the server's limit; snapshots chosen one by
  // one go first so a cut never drops them.
  const selectedCount = redundantRequests.length + uniqueRequests.length;
  const requests = [...uniqueRequests, ...redundantRequests].slice(0, MAX_REFS_PER_REQUEST);
  const count = requests.length;
  const uniqueCount = Math.min(uniqueRequests.length, count);
  const uniqueWarning =
    uniqueCount > 0
      ? ` ${uniqueCount} of them ${uniqueCount === 1 ? 'holds' : 'hold'} work found on no branch or remote; once Git garbage-collects it, that work cannot be recovered.`
      : '';

  return (
    <>
      {redundant.length === 0 && unique.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archive snapshots to delete.</p>
      ) : null}
      {redundant.length > 0 ? (
        <RedundantList
          groups={redundant}
          selected={includeRedundant}
          onSelectedChange={setIncludeRedundant}
        />
      ) : null}
      {unique.length > 0 ? (
        <UniqueWorkList
          groups={unique}
          selectedKeys={selectedUnique}
          onToggle={(key, selected) =>
            setSelectedUnique((current) => {
              const next = new Set(current);
              if (selected) {
                next.add(key);
              } else {
                next.delete(key);
              }
              return next;
            })
          }
          onSelectAll={(selected) =>
            setSelectedUnique(
              selected
                ? new Set(unique.flatMap(({ entries }) => entries.map(({ key }) => key)))
                : new Set()
            )
          }
        />
      ) : null}
      {selectedCount > count ? (
        <p className="text-sm text-muted-foreground">
          {`${selectedCount.toLocaleString()} selected; one run deletes ${count.toLocaleString()}. Run it again for the rest.`}
        </p>
      ) : null}
      <Button
        variant="outline"
        className="w-full sm:w-auto"
        disabled={count === 0 || removeRefs.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        <ArchiveIcon />
        {count === 0 ? 'Delete snapshots' : `Delete ${pluralizeSnapshots(count)}`}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${pluralizeSnapshots(count)}?`}
        description={`Delete ${pluralizeSnapshots(count)} under refs/factory-factory/ from this computer. Branches, remotes and other refs are not changed. A snapshot that changed since this list loaded is skipped.${uniqueWarning}`}
        confirmText="Delete"
        variant="destructive"
        isPending={removeRefs.isPending}
        onConfirm={() => removeRefs.mutate({ refs: requests })}
      />
    </>
  );
}

/**
 * Archive snapshots (`refs/factory-factory/archive/`) and deleted-branch pins
 * (`refs/factory-factory/deleted-branches/`), in two tiers: redundant ones,
 * selected by default, and old ones holding work found nowhere else, selected
 * one by one.
 */
export function ArchivedRefCleanup() {
  const candidatesQuery = trpc.admin.listArchivedRefCandidates.useQuery();
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Archive snapshots</h3>
        <p className="text-sm text-muted-foreground">
          Archiving keeps each workspace's last state, and branch cleanup each deleted branch's last
          commit, under refs/factory-factory/.
        </p>
      </div>
      <QueryState
        query={candidatesQuery}
        errorTitle="Couldn't scan for archive snapshots"
        loading={<Skeleton className="h-10 w-full" />}
        refreshErrorClassName="rounded-md border"
      >
        {(groups) => <ArchivedRefLists groups={groups} />}
      </QueryState>
    </div>
  );
}
