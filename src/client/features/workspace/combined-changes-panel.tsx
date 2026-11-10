import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { type ChangeListEntry, ChangeTreeView, useOpenDiffTab } from './change-panel-shared';
import { fileChangeKindFromDiffStatus, fileChangeKindFromGitStatus } from './file-change-item';

type GitFileStatus = 'M' | 'A' | 'D' | '?';
type DiffFileStatus = 'added' | 'modified' | 'deleted';

interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

interface DiffFile {
  path: string;
  status: DiffFileStatus;
}

interface CombinedChangesPanelProps {
  workspaceId: string;
}

interface CombinedChangesContentProps {
  entries: ChangeListEntry[];
  noMergeBase: boolean;
  indicatorLabel: string;
  partialDataWarning?: string;
  onFileClick: (path: string) => void;
  workspaceId: string;
}

const EMPTY_DIFF_SNAPSHOT = {
  added: [] as DiffFile[],
  modified: [] as DiffFile[],
  deleted: [] as DiffFile[],
  noMergeBase: false,
};

function getDiffSnapshot(
  diffData:
    | { added: DiffFile[]; modified: DiffFile[]; deleted: DiffFile[]; noMergeBase: boolean }
    | undefined,
  diffError: unknown
) {
  if (diffError) {
    return EMPTY_DIFF_SNAPSHOT;
  }
  return diffData ?? EMPTY_DIFF_SNAPSHOT;
}

export function getPartialDataWarning(params: {
  gitError: unknown;
  diffError: unknown;
  unpushedError: unknown;
}): string | undefined {
  if (params.gitError && params.diffError) {
    return 'Git status and diff vs main unavailable.';
  }
  if (params.gitError && params.unpushedError) {
    return 'Git status and not-pushed detection unavailable; showing diff vs main only.';
  }
  if (params.diffError && params.unpushedError) {
    return 'Diff vs main and not-pushed detection unavailable; showing working tree changes only.';
  }
  if (params.gitError) {
    return 'Git status unavailable; showing diff vs main only.';
  }
  if (params.diffError) {
    return 'Diff vs main unavailable; showing working tree changes only.';
  }
  if (params.unpushedError) {
    return 'Not-pushed detection unavailable; showing staged markers only.';
  }
  return undefined;
}

function NoMergeBaseState() {
  return (
    <EmptyState
      size="compact"
      icon={WarningCircleIcon}
      iconClassName="text-warning"
      title="No common history with main"
      description="This branch doesn't share history with the main branch."
      className="h-full"
    />
  );
}

export function getIndicatorLabel(hasUpstream: boolean): string {
  return hasUpstream ? 'Staged or not pushed to remote' : 'Staged';
}

function ChangesDecorators({
  noMergeBase,
  indicatorLabel,
  hasIndicatorEntries,
  partialDataWarning,
}: {
  noMergeBase: boolean;
  indicatorLabel: string;
  hasIndicatorEntries: boolean;
  partialDataWarning?: string;
}) {
  if (!(noMergeBase || hasIndicatorEntries || partialDataWarning)) {
    return null;
  }

  return (
    <div className="space-y-2">
      {partialDataWarning && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <WarningCircleIcon className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{partialDataWarning}</span>
        </div>
      )}
      {noMergeBase && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <WarningCircleIcon className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>No common history with main. Not-pushed detection may be incomplete.</span>
        </div>
      )}
      {hasIndicatorEntries && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />
          <span>{indicatorLabel}</span>
        </div>
      )}
    </div>
  );
}

export function buildCombinedEntries(
  gitFiles: GitStatusFile[],
  diffFiles: DiffFile[],
  unpushedFiles: Set<string>
): ChangeListEntry[] {
  const gitByPath = new Map(gitFiles.map((file) => [file.path, file]));
  const diffByPath = new Map(diffFiles.map((file) => [file.path, file]));
  const allPaths = new Set([...gitByPath.keys(), ...diffByPath.keys()]);

  const entries: ChangeListEntry[] = [];
  for (const path of allPaths) {
    const gitFile = gitByPath.get(path);
    const diffFile = diffByPath.get(path);

    if (gitFile) {
      entries.push({
        path,
        kind: fileChangeKindFromGitStatus(gitFile.status),
        statusCode: gitFile.status,
        showIndicatorDot: gitFile.staged || unpushedFiles.has(path),
      });
      continue;
    }

    if (diffFile) {
      entries.push({
        path,
        kind: fileChangeKindFromDiffStatus(diffFile.status),
        statusCode: diffFile.status[0],
        showIndicatorDot: unpushedFiles.has(path),
      });
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function CombinedChangesContent({
  entries,
  noMergeBase,
  indicatorLabel,
  partialDataWarning,
  onFileClick,
  workspaceId,
}: CombinedChangesContentProps) {
  if (entries.length === 0) {
    if (noMergeBase) {
      return <NoMergeBaseState />;
    }
    if (partialDataWarning) {
      return (
        <EmptyState
          size="compact"
          icon={FileCodeIcon}
          title="No visible changes"
          description={partialDataWarning}
          className="h-full"
        />
      );
    }
    return (
      <EmptyState
        size="compact"
        icon={FileCodeIcon}
        title="No changes"
        description="The working tree is clean and up to date."
        className="h-full"
      />
    );
  }

  const hasIndicatorEntries = entries.some((entry) => entry.showIndicatorDot);
  const decorators = (
    <ChangesDecorators
      noMergeBase={noMergeBase}
      indicatorLabel={indicatorLabel}
      hasIndicatorEntries={hasIndicatorEntries}
      partialDataWarning={partialDataWarning}
    />
  );

  if (entries.length > 200) {
    return (
      <div className="h-full flex flex-col">
        {(noMergeBase || hasIndicatorEntries || partialDataWarning) && (
          <div className="p-2 border-b">{decorators}</div>
        )}
        <div className="flex-1 min-h-0 p-1">
          <ChangeTreeView
            entries={entries}
            onFileClick={onFileClick}
            indicatorLabel={indicatorLabel}
            workspaceId={workspaceId}
            virtualized
          />
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-1 space-y-2">
        {decorators}
        <ChangeTreeView
          entries={entries}
          onFileClick={onFileClick}
          indicatorLabel={indicatorLabel}
          workspaceId={workspaceId}
        />
      </div>
    </ScrollArea>
  );
}

export function CombinedChangesPanel({ workspaceId }: CombinedChangesPanelProps) {
  const openDiffTab = useOpenDiffTab();

  const {
    data: gitData,
    isLoading: isGitLoading,
    error: gitQueryError,
    isFetching: isGitFetching,
    refetch: refetchGit,
  } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { refetchInterval: POLL_INTERVAL_MS.workspaceContext, staleTime: 10_000 }
  );
  const {
    data: diffData,
    isLoading: isDiffLoading,
    error: diffQueryError,
    isFetching: isDiffFetching,
    refetch: refetchDiff,
  } = trpc.workspace.getDiffVsMain.useQuery(
    { workspaceId },
    { refetchInterval: POLL_INTERVAL_MS.workspaceContext, staleTime: 10_000 }
  );
  const {
    data: unpushedData,
    isLoading: isUnpushedLoading,
    error: unpushedQueryError,
    isFetching: isUnpushedFetching,
    refetch: refetchUnpushed,
  } = trpc.workspace.getUnpushedFiles.useQuery(
    { workspaceId },
    { refetchInterval: POLL_INTERVAL_MS.workspaceContext, staleTime: 10_000 }
  );

  if (isGitLoading || isDiffLoading || isUnpushedLoading) {
    return <Loading size="compact" message="Loading changes…" />;
  }

  // Cached results stay visible while a background refetch fails; only a query
  // with no data counts as failed.
  const gitError = gitData ? null : gitQueryError;
  const diffError = diffData ? null : diffQueryError;
  const unpushedError = unpushedData ? null : unpushedQueryError;

  if (gitError && diffError) {
    return (
      <QueryErrorState
        title="Couldn't load changes"
        error={gitError}
        onRetry={() => {
          void refetchGit();
          void refetchDiff();
          void refetchUnpushed();
        }}
        isRetrying={isGitFetching || isDiffFetching || isUnpushedFetching}
        className="h-full"
      />
    );
  }

  const gitFiles: GitStatusFile[] = gitError ? [] : (gitData?.files ?? []);
  const snapshot = getDiffSnapshot(diffData, diffError);
  const partialDataWarning = getPartialDataWarning({ gitError, diffError, unpushedError });
  const indicatorLabel = getIndicatorLabel(unpushedData?.hasUpstream ?? false);
  const unpushedFiles = new Set(unpushedError ? [] : (unpushedData?.files ?? []));
  const entries = buildCombinedEntries(
    gitFiles,
    [...snapshot.added, ...snapshot.modified, ...snapshot.deleted],
    unpushedFiles
  );

  return (
    <CombinedChangesContent
      entries={entries}
      noMergeBase={snapshot.noMergeBase}
      indicatorLabel={indicatorLabel}
      partialDataWarning={partialDataWarning}
      onFileClick={openDiffTab}
      workspaceId={workspaceId}
    />
  );
}
