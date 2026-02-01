'use client';

import { AlertCircle, Eye, FileCode, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface DiffViewerProps {
  workspaceId: string;
  filePath: string;
}

interface DiffLine {
  type: 'header' | 'addition' | 'deletion' | 'context' | 'hunk';
  content: string;
  lineNumber?: {
    old?: number;
    new?: number;
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: diff parsing requires checking multiple line types
function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file')
    ) {
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -start,count +start,count @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'addition',
        content: line.slice(1),
        lineNumber: { new: newLine++ },
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'deletion',
        content: line.slice(1),
        lineNumber: { old: oldLine++ },
      });
    } else if (line.startsWith(' ') || line === '') {
      result.push({
        type: 'context',
        content: line.slice(1) || '',
        lineNumber: { old: oldLine++, new: newLine++ },
      });
    }
  }

  return result;
}

// =============================================================================
// Sub-Components
// =============================================================================

interface MarkdownPreviewProps {
  workspaceId: string;
  filePath: string;
}

function MarkdownPreview({ workspaceId, filePath }: MarkdownPreviewProps) {
  const {
    data: fileData,
    isLoading: isLoadingFile,
    error: fileError,
  } = trpc.workspace.readFile.useQuery({
    workspaceId,
    path: filePath,
  });

  if (isLoadingFile) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <p className="text-lg font-medium text-destructive">Failed to load file</p>
        <p className="text-sm text-muted-foreground mt-2">{fileError.message}</p>
      </div>
    );
  }

  if (fileData?.isBinary) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <p className="text-muted-foreground">Binary file cannot be previewed</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <MarkdownRenderer content={fileData?.content ?? ''} />
    </div>
  );
}

interface DiffLineProps {
  line: DiffLine;
  lineNumberWidth: number;
}

function DiffLineComponent({ line, lineNumberWidth }: DiffLineProps) {
  const bgColor = {
    header: 'bg-muted/50',
    hunk: 'bg-blue-500/10',
    addition: 'bg-green-500/20',
    deletion: 'bg-red-500/20',
    context: '',
  }[line.type];

  const textColor = {
    header: 'text-muted-foreground',
    hunk: 'text-blue-400',
    addition: 'text-green-400',
    deletion: 'text-red-400',
    context: 'text-foreground',
  }[line.type];

  const prefix = {
    header: '',
    hunk: '',
    addition: '+',
    deletion: '-',
    context: ' ',
  }[line.type];

  return (
    <div className={cn('flex font-mono text-xs', bgColor)}>
      {/* Line numbers */}
      <div className="flex-shrink-0 flex text-muted-foreground border-r border-border select-none">
        <span
          className="box-content px-1 text-right border-r border-border tabular-nums"
          style={{ width: `${lineNumberWidth}ch` }}
        >
          {line.lineNumber?.old ?? ''}
        </span>
        <span
          className="box-content px-1 text-right tabular-nums"
          style={{ width: `${lineNumberWidth}ch` }}
        >
          {line.lineNumber?.new ?? ''}
        </span>
      </div>

      {/* Prefix */}
      <span className={cn('flex-shrink-0 w-4 text-center select-none', textColor)}>{prefix}</span>

      {/* Content */}
      <pre className={cn('flex-1 whitespace-pre-wrap break-all px-2', textColor)}>
        {line.content}
      </pre>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function DiffViewer({ workspaceId, filePath }: DiffViewerProps) {
  const { data, isLoading, error } = trpc.workspace.getFileDiff.useQuery({
    workspaceId,
    filePath,
  });

  // Check if file is markdown
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.markdown');

  const [showPreview, setShowPreview] = useState(false);

  const parsedDiff = useMemo(() => {
    if (!data?.diff) {
      return [];
    }
    return parseDiff(data.diff);
  }, [data?.diff]);

  // Calculate the width needed for line numbers (minimum 3 characters)
  const lineNumberWidth = useMemo(() => {
    let maxLineNumber = 0;
    for (const line of parsedDiff) {
      if (line.lineNumber?.old && line.lineNumber.old > maxLineNumber) {
        maxLineNumber = line.lineNumber.old;
      }
      if (line.lineNumber?.new && line.lineNumber.new > maxLineNumber) {
        maxLineNumber = line.lineNumber.new;
      }
    }
    return Math.max(3, String(maxLineNumber).length);
  }, [parsedDiff]);

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
        <p className="text-lg font-medium text-destructive">Failed to load diff</p>
        <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
      </div>
    );
  }

  if (!data?.diff || parsedDiff.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <FileCode className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium text-muted-foreground">No changes</p>
        <p className="text-sm text-muted-foreground/70 mt-2">{filePath}</p>
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
        {isMarkdown && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(!showPreview)}
            className="h-7 gap-1.5 flex-shrink-0"
          >
            {showPreview ? <FileCode className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showPreview ? 'Diff' : 'Preview'}
          </Button>
        )}
      </div>

      {/* Content */}
      {isMarkdown && showPreview ? (
        <ScrollArea className="flex-1">
          <MarkdownPreview workspaceId={workspaceId} filePath={filePath} />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1">
          <div className="min-w-fit">
            {parsedDiff.map((line, index) => (
              <DiffLineComponent
                key={`${line.type}-${line.lineNumber?.old ?? ''}-${line.lineNumber?.new ?? ''}-${index}`}
                line={line}
                lineNumberWidth={lineNumberWidth}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
