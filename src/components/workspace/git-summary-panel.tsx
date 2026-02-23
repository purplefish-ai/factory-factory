import { trpc } from '@/client/lib/trpc';

import {
  type ChangeListEntry,
  PanelEmptyState,
  PanelErrorState,
  PanelLoadingState,
  ScrollableChangeSections,
  useOpenDiffTab,
} from './change-panel-shared';
import { fileChangeKindFromGitStatus } from './file-change-item';

// =============================================================================
// Types
// =============================================================================

type GitFileStatus = 'M' | 'A' | 'D' | '?';

interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

interface GitSummaryPanelProps {
  workspaceId: string;
}

// =============================================================================
// Main Component
// =============================================================================

export function GitSummaryPanel({ workspaceId }: GitSummaryPanelProps) {
  const openDiffTab = useOpenDiffTab();

  const { data, isLoading, error } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  if (isLoading) {
    return <PanelLoadingState />;
  }

  if (error) {
    return <PanelErrorState title="Failed to load git status" errorMessage={error.message} />;
  }

  const files = data?.files ?? [];

  if (files.length === 0) {
    return <PanelEmptyState title="No changes" description="Working tree is clean" />;
  }

  // Group files by status
  const toEntry = (file: GitStatusFile): ChangeListEntry => ({
    path: file.path,
    kind: fileChangeKindFromGitStatus(file.status),
    statusCode: file.status,
  });
  const stagedEntries = files.filter((f) => f.staged).map(toEntry);
  const unstagedEntries = files.filter((f) => !f.staged).map(toEntry);

  return (
    <ScrollableChangeSections
      onFileClick={openDiffTab}
      sections={[
        {
          key: 'staged',
          title: 'Staged',
          entries: stagedEntries,
        },
        {
          key: 'unstaged',
          title: 'Changes',
          entries: unstagedEntries,
        },
      ]}
      className="p-2 space-y-3"
      beforeSections={
        data?.hasUncommitted ? (
          <div className="flex items-center gap-1.5 px-3 py-1 bg-orange-500/10 rounded text-xs text-orange-600 dark:text-orange-400">
            <span className="h-1.5 w-1.5 rounded-full bg-current shrink-0" />
            <span>Uncommitted changes</span>
          </div>
        ) : null
      }
    />
  );
}
