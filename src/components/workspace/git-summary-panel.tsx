import { AlertCircle, FileCode, Loader2 } from 'lucide-react';
import { useCallback } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

import { FileChangeItem, fileChangeKindFromGitStatus } from './file-change-item';
import { useWorkspacePanel } from './workspace-panel-context';

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
  const { openTab } = useWorkspacePanel();

  const { data, isLoading, error } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  const handleFileClick = useCallback(
    (file: GitStatusFile) => {
      openTab('diff', file.path, `Diff: ${file.path.split('/').pop()}`);
    },
    [openTab]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-sm text-destructive">Failed to load git status</p>
        <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
      </div>
    );
  }

  const files = data?.files ?? [];

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <FileCode className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm font-medium text-muted-foreground">No changes</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Working tree is clean</p>
      </div>
    );
  }

  // Group files by status
  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => !f.staged);

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-3">
        {data?.hasUncommitted && (
          <div className="flex items-center gap-1.5 px-3 py-1 bg-orange-500/10 rounded text-xs text-orange-600 dark:text-orange-400">
            <span className="h-1.5 w-1.5 rounded-full bg-current shrink-0" />
            <span>Uncommitted changes</span>
          </div>
        )}
        {stagedFiles.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Staged ({stagedFiles.length})
            </h3>
            <div className="space-y-0.5">
              {stagedFiles.map((file) => (
                <FileChangeItem
                  key={file.path}
                  path={file.path}
                  kind={fileChangeKindFromGitStatus(file.status)}
                  statusCode={file.status}
                  onClick={() => handleFileClick(file)}
                />
              ))}
            </div>
          </div>
        )}

        {unstagedFiles.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Changes ({unstagedFiles.length})
            </h3>
            <div className="space-y-0.5">
              {unstagedFiles.map((file) => (
                <FileChangeItem
                  key={file.path}
                  path={file.path}
                  kind={fileChangeKindFromGitStatus(file.status)}
                  statusCode={file.status}
                  onClick={() => handleFileClick(file)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
