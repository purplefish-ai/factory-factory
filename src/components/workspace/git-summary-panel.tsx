'use client';

import { AlertCircle, FileCode, FileMinus, FilePlus, FileQuestion, Loader2 } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

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
// Helper Components
// =============================================================================

function getStatusIcon(status: GitFileStatus) {
  switch (status) {
    case 'M':
      return <FileCode className="h-4 w-4" />;
    case 'A':
      return <FilePlus className="h-4 w-4" />;
    case 'D':
      return <FileMinus className="h-4 w-4" />;
    case '?':
      return <FileQuestion className="h-4 w-4" />;
  }
}

function getStatusColor(status: GitFileStatus): string {
  switch (status) {
    case 'M':
      return 'text-yellow-500';
    case 'A':
      return 'text-green-500';
    case 'D':
      return 'text-red-500';
    case '?':
      return 'text-muted-foreground';
  }
}

function getStatusLabel(status: GitFileStatus): string {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case '?':
      return 'Untracked';
  }
}

interface FileItemProps {
  file: GitStatusFile;
  onClick: () => void;
}

function FileItem({ file, onClick }: FileItemProps) {
  const statusColor = getStatusColor(file.status);
  const fileName = file.path.split('/').pop() ?? file.path;
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
        'hover:bg-muted/50 rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={`${getStatusLabel(file.status)}: ${file.path}`}
    >
      <span className={statusColor}>{getStatusIcon(file.status)}</span>
      <span className="flex-1 truncate">
        <span className="font-medium">{fileName}</span>
        {dirPath && <span className="text-muted-foreground ml-1 text-xs">{dirPath}</span>}
      </span>
      <span className={cn('text-xs font-mono', statusColor)}>{file.status}</span>
    </button>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function GitSummaryPanel({ workspaceId }: GitSummaryPanelProps) {
  const { openTab } = useWorkspacePanel();

  const { data, isLoading, error } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { refetchInterval: 5000 }
  );

  const handleFileClick = (file: GitStatusFile) => {
    openTab('diff', file.path, `Diff: ${file.path.split('/').pop()}`);
  };

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
        {stagedFiles.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Staged ({stagedFiles.length})
            </h3>
            <div className="space-y-0.5">
              {stagedFiles.map((file) => (
                <FileItem key={file.path} file={file} onClick={() => handleFileClick(file)} />
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
                <FileItem key={file.path} file={file} onClick={() => handleFileClick(file)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
