'use client';

import { AlertCircle, AlertTriangle, FileCode, Loader2 } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

// =============================================================================
// Types
// =============================================================================

interface FileViewerProps {
  workspaceId: string;
  filePath: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// Main Component
// =============================================================================

export function FileViewer({ workspaceId, filePath }: FileViewerProps) {
  const { data, isLoading, error } = trpc.workspace.readFile.useQuery({
    workspaceId,
    path: filePath,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <p className="text-lg font-medium text-destructive">Failed to load file</p>
        <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <FileCode className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium text-muted-foreground">No content</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm font-mono text-foreground truncate">{filePath}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
          <span>{formatFileSize(data.size)}</span>
          <span className="uppercase">{data.language}</span>
        </div>
      </div>

      {/* Warnings */}
      {data.truncated && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          <span className="text-sm text-yellow-500">
            File truncated to 1MB. Actual size: {formatFileSize(data.size)}
          </span>
        </div>
      )}

      {data.isBinary && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Binary file cannot be displayed</span>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        {data.isBinary ? (
          <div className="flex items-center justify-center h-full p-8">
            <p className="text-muted-foreground">{data.content}</p>
          </div>
        ) : (
          <SyntaxHighlighter
            language={data.language}
            style={oneLight}
            showLineNumbers
            wrapLines
            customStyle={{
              margin: 0,
              padding: '1rem',
              background: 'transparent',
              fontSize: '0.75rem',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: {
                background: 'transparent',
              },
            }}
            lineNumberStyle={{
              minWidth: '3em',
              paddingRight: '1em',
              color: 'var(--muted-foreground)',
              background: 'transparent',
            }}
            lineProps={{
              style: {
                background: 'transparent',
              },
            }}
          >
            {data.content}
          </SyntaxHighlighter>
        )}
      </ScrollArea>
    </div>
  );
}
