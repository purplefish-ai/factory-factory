import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { useTheme } from 'next-themes';
import { useCallback, useMemo, useRef, useState } from 'react';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { EmptyState } from '@/client/components/empty-state';
import { QueryState } from '@/client/components/query-state';
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
  const file = trpc.workspace.readFile.useQuery({ workspaceId, path: filePath });
  return (
    <QueryState
      query={file}
      errorTitle="Couldn't load file"
      loadingMessage="Loading preview…"
      className="h-full"
      isEmpty={(data) => data.isBinary}
      empty={
        <EmptyState
          icon={FileCodeIcon}
          title="Binary file cannot be previewed"
          className="h-full"
        />
      }
    >
      {(data) => (
        <div className="p-4">
          <MarkdownRenderer content={data.content} />
        </div>
      )}
    </QueryState>
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
  const diffQuery = trpc.workspace.getFileDiff.useQuery({ workspaceId, filePath });
  const { data } = diffQuery;

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

  return (
    <div className="flex h-full flex-col">
      <QueryState
        query={diffQuery}
        errorTitle="Couldn't load diff"
        loadingMessage="Loading diff…"
        className="h-full"
        isEmpty={(loaded) => !loaded.diff || parsedDiff.length === 0}
        empty={
          <EmptyState
            icon={FileCodeIcon}
            title="No changes"
            description={filePath}
            className="h-full"
          />
        }
      >
        {() => (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
              <div className="flex items-center gap-2 min-w-0">
                <FileCodeIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm font-mono text-foreground truncate">{filePath}</span>
              </div>
              {isMarkdown && (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => setShowPreview(!showPreview)}
                  className="flex-shrink-0"
                >
                  {showPreview ? <FileCodeIcon /> : <EyeIcon />}
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
        )}
      </QueryState>
    </div>
  );
}
