import { ChevronDown, ChevronRight, File, FileCode, Folder, Loader2 } from 'lucide-react';
import { memo, useCallback } from 'react';

import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

import { useFileTreeExpansion } from './file-tree-context';

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
    return <FileCode className="h-4 w-4" />;
  }
  return <File className="h-4 w-4" />;
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
      <button
        type="button"
        onClick={toggleExpand}
        className={cn(
          'w-full flex items-center gap-1 px-2 py-1 text-sm text-left',
          'hover:bg-muted/50 rounded-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}
        <Folder className="h-4 w-4 text-brand flex-shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>

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
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'w-full flex items-center gap-1 px-2 py-1 text-sm text-left',
        'hover:bg-muted/50 rounded-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 20}px` }}
    >
      <span className="text-muted-foreground flex-shrink-0">{getFileIcon(entry.name)}</span>
      <span className="truncate">{entry.name}</span>
    </button>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export function FileTree({ workspaceId, path = '', depth = 0, onFileSelect }: FileTreeProps) {
  const { data, isLoading, error } = trpc.workspace.listFiles.useQuery(
    {
      workspaceId,
      path: path || undefined,
    },
    {
      // Refetch periodically at root level only; subdirectories rarely change
      refetchInterval: depth === 0 ? 30_000 : false,
      // Keep data fresh for 20s to avoid refetching on window focus or navigation
      staleTime: 20_000,
      // Disable refetch on window focus - too aggressive for file trees
      refetchOnWindowFocus: false,
    }
  );

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="px-2 py-1 text-sm text-destructive"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        Failed to load: {error.message}
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const hasWorktree = data?.hasWorktree ?? false;

  if (entries.length === 0) {
    // Show different message based on whether workspace has a worktree
    if (!hasWorktree && depth === 0) {
      return (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          <p className="font-medium mb-1">No files available</p>
          <p className="text-xs">This workspace doesn't have a directory configured yet.</p>
        </div>
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
