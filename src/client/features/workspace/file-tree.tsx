import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { memo, useCallback } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useFileTreeExpansion } from './file-tree-context';
import { FileTreeRow } from './file-tree-row';

// =============================================================================
// Types
// =============================================================================

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

interface FileTreeProps {
  workspaceId: string;
  path?: string;
  depth?: number;
  onFileSelect: (path: string, name: string) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  const codeExtensions = [
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'swift',
    'css',
    'scss',
    'html',
    'xml',
    'json',
    'yaml',
    'yml',
    'md',
    'sql',
    'graphql',
    'sh',
    'bash',
    'zsh',
    'prisma',
  ];

  if (ext && codeExtensions.includes(ext)) {
    return <FileCodeIcon className="h-4 w-4" />;
  }
  return <FileIcon className="h-4 w-4" />;
}

// =============================================================================
// Sub-Components
// =============================================================================

interface DirectoryNodeProps {
  workspaceId: string;
  entry: FileEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
}

const DirectoryNode = memo(function DirectoryNode({
  workspaceId,
  entry,
  depth,
  onFileSelect,
}: DirectoryNodeProps) {
  const { isExpanded: checkExpanded, toggleExpanded } = useFileTreeExpansion();
  const isExpanded = checkExpanded(entry.path);

  const toggleExpand = useCallback(() => {
    toggleExpanded(entry.path);
  }, [toggleExpanded, entry.path]);

  return (
    <div>
      <FileTreeRow
        onClick={toggleExpand}
        depth={depth}
        expanded={isExpanded}
        icon={<FolderIcon className="h-4 w-4 text-brand" />}
        label={entry.name}
      />

      {isExpanded && (
        <FileTree
          workspaceId={workspaceId}
          path={entry.path}
          depth={depth + 1}
          onFileSelect={onFileSelect}
        />
      )}
    </div>
  );
});

interface FileNodeProps {
  entry: FileEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
}

const FileNode = memo(function FileNode({ entry, depth, onFileSelect }: FileNodeProps) {
  const handleClick = useCallback(() => {
    onFileSelect(entry.path, entry.name);
  }, [onFileSelect, entry.path, entry.name]);

  return (
    <FileTreeRow
      onClick={handleClick}
      depth={depth}
      icon={<span className="text-muted-foreground">{getFileIcon(entry.name)}</span>}
      label={entry.name}
    />
  );
});

// =============================================================================
// Main Component
// =============================================================================

export function FileTree({ workspaceId, path = '', depth = 0, onFileSelect }: FileTreeProps) {
  const { data, isLoading, error, refetch, isFetching } = trpc.workspace.listFiles.useQuery(
    {
      workspaceId,
      path: path || undefined,
    },
    {
      // Refetch periodically at root level only; subdirectories rarely change
      refetchInterval: depth === 0 ? POLL_INTERVAL_MS.background : false,
      // Keep data fresh for 20s to avoid refetching on window focus or navigation
      staleTime: 20_000,
    }
  );

  if (isLoading || !(data || error)) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <Spinner aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 px-2 py-1 text-sm text-destructive"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span>Couldn't load folder. {error.message}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching}
        >
          {isFetching ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const hasWorktree = data?.hasWorktree ?? false;

  if (entries.length === 0) {
    // Show different message based on whether workspace has a worktree
    if (!hasWorktree && depth === 0) {
      return (
        <EmptyState
          size="compact"
          icon={FolderIcon}
          title="No files available"
          description="This workspace doesn't have a directory yet."
        />
      );
    }

    return (
      <div
        className="px-2 py-1 text-sm text-muted-foreground italic"
        style={{ paddingLeft: `${depth * 12 + 8 + 20}px` }}
      >
        Empty directory
      </div>
    );
  }

  return (
    <div>
      {entries.map((entry) =>
        entry.type === 'directory' ? (
          <DirectoryNode
            key={entry.path}
            workspaceId={workspaceId}
            entry={entry}
            depth={depth}
            onFileSelect={onFileSelect}
          />
        ) : (
          <FileNode key={entry.path} entry={entry} depth={depth} onFileSelect={onFileSelect} />
        )
      )}
    </div>
  );
}
