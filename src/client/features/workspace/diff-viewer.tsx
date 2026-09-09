import { EyeIcon, FileCodeIcon, SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useCallback, useMemo, useRef, useState } from 'react';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { calculateLineNumberWidth, parseDetailedDiff } from '@/lib/diff/parse';
import { getLanguageFromPath } from '@/lib/language-detection';
import { DiffLines } from './diff-lines';
import type { ScrollState } from './scroll-state';
import { useDiffHighlighting } from './use-diff-highlighting';
import { usePersistentScroll } from './use-persistent-scroll';
import { useWorkspacePanel } from './workspace-panel-context';

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
        <SpinnerGapIcon className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <WarningCircleIcon className="h-12 w-12 text-destructive mb-4" />
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

// =============================================================================
// Main Component
// =============================================================================

export function DiffViewer({ workspaceId, filePath, tabId }: DiffViewerProps) {
  const { resolvedTheme } = useTheme();
  const { getScrollState, setScrollState } = useWorkspacePanel();
  const saveDiffScrollState = useCallback(
    (state: ScrollState) => setScrollState(tabId, 'code', state),
    [setScrollState, tabId]
  );
  const { data, isLoading, error } = trpc.workspace.getFileDiff.useQuery({
    workspaceId,
    filePath,
  });

  // Check if file is markdown
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.markdown');

  const [showPreview, setShowPreview] = useState(isMarkdown);
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

  const tokenMap = useDiffHighlighting(parsedDiff, language, syntaxTheme, !showPreview);

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
        <SpinnerGapIcon className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <WarningCircleIcon className="h-12 w-12 text-destructive mb-4" />
        <p className="text-lg font-medium text-destructive">Failed to load diff</p>
        <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
      </div>
    );
  }

  if (!data?.diff || parsedDiff.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <FileCodeIcon className="h-12 w-12 text-muted-foreground mb-4" />
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
          <FileCodeIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm font-mono text-foreground truncate">{filePath}</span>
        </div>
        {isMarkdown && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(!showPreview)}
            className="h-7 gap-1.5 flex-shrink-0"
          >
            {showPreview ? (
              <FileCodeIcon className="h-3.5 w-3.5" />
            ) : (
              <EyeIcon className="h-3.5 w-3.5" />
            )}
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
        <ScrollArea className="flex-1" viewportRef={diffViewportRef}>
          <DiffLines
            lines={parsedDiff}
            lineNumberWidth={lineNumberWidth}
            tokenMap={tokenMap}
            scrollContainerRef={diffViewportRef}
            scrollState={getScrollState(tabId, 'code')}
            onScrollStateChange={saveDiffScrollState}
          />
        </ScrollArea>
      )}
    </div>
  );
}
