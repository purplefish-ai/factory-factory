'use client';

import { ChevronDown, ChevronRight, File, FileCode, Folder, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

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

function DirectoryNode({ workspaceId, entry, depth, onFileSelect }: DirectoryNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

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
        <Folder className="h-4 w-4 text-blue-400 flex-shrink-0" />
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
}

interface FileNodeProps {
  entry: FileEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
}

function FileNode({ entry, depth, onFileSelect }: FileNodeProps) {
  return (
    <button
      type="button"
      onClick={() => onFileSelect(entry.path, entry.name)}
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
}

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
      // Refetch when window focuses to pick up new files or worktree changes
      refetchOnWindowFocus: true,
      // Refetch periodically to catch worktree creation
      refetchInterval: depth === 0 ? 10_000 : false, // Only root level refetches
      // Consider data stale immediately so it refetches on mount
      staleTime: 0,
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
