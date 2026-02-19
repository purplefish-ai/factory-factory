import { AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

import {
  ChangeList,
  type ChangeListEntry,
  PanelEmptyState,
  PanelErrorState,
  PanelLoadingState,
  useOpenDiffTab,
  VirtualizedChangeList,
} from './change-panel-shared';
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
  hasUpstream: boolean;
  partialDataWarning?: string;
  onFileClick: (path: string) => void;
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
    <div className="flex flex-col items-center justify-center h-full text-center p-4">
      <AlertCircle className="h-8 w-8 text-warning mb-2" />
      <p className="text-sm font-medium text-muted-foreground">No common history with main</p>
      <p className="text-xs text-muted-foreground/70 mt-1">
        This branch doesn't share history with the main branch
      </p>
    </div>
  );
}

function ChangesDecorators({
  noMergeBase,
  hasUpstream,
  hasIndicatorEntries,
  partialDataWarning,
}: {
  noMergeBase: boolean;
  hasUpstream: boolean;
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
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{partialDataWarning}</span>
        </div>
      )}
      {noMergeBase && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>No common history with main. Not-pushed detection may be incomplete.</span>
        </div>
      )}
      {hasIndicatorEntries && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500 shrink-0" />
          <span>{hasUpstream ? 'Staged or not pushed to remote' : 'Staged'}</span>
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
  hasUpstream,
  partialDataWarning,
  onFileClick,
}: CombinedChangesContentProps) {
  if (entries.length === 0) {
    if (noMergeBase) {
      return <NoMergeBaseState />;
    }
    if (partialDataWarning) {
      return <PanelEmptyState title="No visible changes" description={partialDataWarning} />;
    }
    return (
      <PanelEmptyState title="No changes" description="Working tree is clean and up to date" />
    );
  }

  const hasIndicatorEntries = entries.some((entry) => entry.showIndicatorDot);
  const decorators = (
    <ChangesDecorators
      noMergeBase={noMergeBase}
      hasUpstream={hasUpstream}
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
        <VirtualizedChangeList entries={entries} onFileClick={onFileClick} className="flex-1" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-2">
        {decorators}
        <ChangeList entries={entries} onFileClick={onFileClick} />
      </div>
    </ScrollArea>
  );
}

export function CombinedChangesPanel({ workspaceId }: CombinedChangesPanelProps) {
  const openDiffTab = useOpenDiffTab();

  const {
    data: gitData,
    isLoading: isGitLoading,
    error: gitError,
  } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );
  const {
    data: diffData,
    isLoading: isDiffLoading,
    error: diffError,
  } = trpc.workspace.getDiffVsMain.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );
  const {
    data: unpushedData,
    isLoading: isUnpushedLoading,
    error: unpushedError,
  } = trpc.workspace.getUnpushedFiles.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  if (isGitLoading || isDiffLoading || isUnpushedLoading) {
    return <PanelLoadingState />;
  }

  if (gitError && diffError) {
    return (
      <PanelErrorState
        title="Failed to load changes"
        errorMessage={gitError?.message ?? diffError?.message}
      />
    );
  }

  const gitFiles: GitStatusFile[] = gitError ? [] : (gitData?.files ?? []);
  const snapshot = getDiffSnapshot(diffData, diffError);
  const partialDataWarning = getPartialDataWarning({ gitError, diffError, unpushedError });
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
      hasUpstream={unpushedData?.hasUpstream ?? false}
      partialDataWarning={partialDataWarning}
      onFileClick={openDiffTab}
    />
  );
}
