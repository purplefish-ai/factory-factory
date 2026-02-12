import { AlertCircle, Eye, FileCode, Loader2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useMemo, useRef, useState } from 'react';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import {
  calculateLineNumberWidth,
  type DiffLine,
  getDiffLineBackground,
  getDiffLinePrefix,
  getDiffLineTextColor,
  type LineTokenMap,
  parseDetailedDiff,
  type SyntaxToken,
  tokenizeDiffLines,
} from '@/lib/diff';
import { getLanguageFromPath } from '@/lib/language-detection';
import { cn } from '@/lib/utils';
import { usePersistentScroll } from './use-persistent-scroll';

// =============================================================================
// Types
// =============================================================================

interface DiffViewerProps {
  workspaceId: string;
  filePath: string;
  tabId: string;
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

interface SyntaxHighlightedContentProps {
  tokens: SyntaxToken[];
}

function SyntaxHighlightedContent({ tokens }: SyntaxHighlightedContentProps) {
  return (
    <>
      {tokens.map((token, i) => {
        const key = `${i}-${token.content.length}`;
        return (
          <span key={key} style={token.style}>
            {token.content}
          </span>
        );
      })}
    </>
  );
}

interface DiffLineProps {
  line: DiffLine;
  lineNumberWidth: number;
  tokens?: SyntaxToken[] | null;
}

function DiffLineComponent({ line, lineNumberWidth, tokens }: DiffLineProps) {
  const bgColor = getDiffLineBackground(line.type);
  const prefix = getDiffLinePrefix(line.type);
  const hasTokens = tokens != null && tokens.length > 0;
  // When syntax tokens are available, let them control text color for code lines.
  // Header/hunk lines and lines without tokens use the standard diff text color.
  const textColor = hasTokens ? undefined : getDiffLineTextColor(line.type);

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

      {/* Prefix — always uses diff text color */}
      <span
        className={cn('flex-shrink-0 w-4 text-center select-none', getDiffLineTextColor(line.type))}
      >
        {prefix}
      </span>

      {/* Content */}
      <pre className={cn('flex-1 whitespace-pre-wrap break-all px-2', textColor)}>
        {hasTokens ? <SyntaxHighlightedContent tokens={tokens} /> : line.content}
      </pre>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function DiffViewer({ workspaceId, filePath, tabId }: DiffViewerProps) {
  const { resolvedTheme } = useTheme();
  const { data, isLoading, error } = trpc.workspace.getFileDiff.useQuery({
    workspaceId,
    filePath,
  });

  // Check if file is markdown
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.markdown');

  const [showPreview, setShowPreview] = useState(false);
  const diffViewportRef = useRef<HTMLDivElement>(null);
  const markdownViewportRef = useRef<HTMLDivElement>(null);

  const parsedDiff = useMemo(() => {
    if (!data?.diff) {
      return [];
    }
    return parseDetailedDiff(data.diff);
  }, [data?.diff]);

  // Calculate the width needed for line numbers (minimum 3 characters)
  const lineNumberWidth = useMemo(() => {
    return calculateLineNumberWidth(parsedDiff);
  }, [parsedDiff]);

  // Syntax highlighting
  const syntaxTheme = resolvedTheme === 'dark' ? oneDark : oneLight;
  const language = getLanguageFromPath(filePath);

  const tokenMap: LineTokenMap | null = useMemo(() => {
    if (parsedDiff.length === 0) {
      return null;
    }
    return tokenizeDiffLines(parsedDiff, language, syntaxTheme);
  }, [parsedDiff, language, syntaxTheme]);

  const { handleScroll: handleDiffScroll } = usePersistentScroll({
    tabId,
    mode: 'code',
    viewportRef: diffViewportRef,
    enabled: !showPreview,
    restoreDeps: [showPreview, filePath, data?.diff?.length],
  });

  const { handleScroll: handleMarkdownScroll } = usePersistentScroll({
    tabId,
    mode: 'markdown',
    viewportRef: markdownViewportRef,
    enabled: showPreview && isMarkdown,
    restoreDeps: [showPreview, filePath, data?.diff?.length],
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
        <ScrollArea
          className="flex-1"
          onScroll={handleMarkdownScroll}
          viewportRef={markdownViewportRef}
        >
          <MarkdownPreview workspaceId={workspaceId} filePath={filePath} />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1" onScroll={handleDiffScroll} viewportRef={diffViewportRef}>
          <div className="min-w-fit">
            {parsedDiff.map((line, index) => (
              <DiffLineComponent
                key={`${line.type}-${line.lineNumber?.old ?? ''}-${line.lineNumber?.new ?? ''}-${index}`}
                line={line}
                lineNumberWidth={lineNumberWidth}
                tokens={tokenMap?.get(index)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
