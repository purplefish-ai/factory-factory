import {
  EyeIcon,
  FileCodeIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import type { inferRouterOutputs } from '@trpc/server';
import { useTheme } from 'next-themes';
import type { RefObject, UIEvent } from 'react';
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { AppRouter } from '@/client/lib/trpc';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  FILE_HIGHLIGHT_BLOCK_LINES,
  isFileBlockWithinByteBudget,
} from '@/lib/diff/file-highlight-limits';
import type { LineTokenMap, SyntaxToken } from '@/lib/diff/syntax-highlight';
import { useFileHighlighting } from './use-diff-highlighting';
import { usePersistentScroll } from './use-persistent-scroll';

// =============================================================================
// Types
// =============================================================================

interface FileViewerProps {
  workspaceId: string;
  filePath: string;
  tabId: string;
}

type RouterOutputs = inferRouterOutputs<AppRouter>;
type FileData = RouterOutputs['workspace']['readFile'];

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

export function FileViewer({ workspaceId, filePath, tabId }: FileViewerProps) {
  const { resolvedTheme } = useTheme();
  const { data, isLoading, error } = trpc.workspace.readFile.useQuery({
    workspaceId,
    path: filePath,
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
        <p className="text-lg font-medium text-destructive">Failed to load file</p>
        <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <FileCodeIcon className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium text-muted-foreground">No content</p>
      </div>
    );
  }

  const syntaxTheme = resolvedTheme === 'dark' ? oneDark : oneLight;

  return (
    <FileViewerLoaded filePath={filePath} tabId={tabId} data={data} syntaxTheme={syntaxTheme} />
  );
}

interface FileViewerLoadedProps {
  filePath: string;
  tabId: string;
  data: FileData;
  syntaxTheme: NonNullable<SyntaxHighlighterProps['style']>;
}

function FileViewerHeader({
  filePath,
  isMarkdown,
  showPreview,
  onTogglePreview,
  fileSizeLabel,
  language,
}: {
  filePath: string;
  isMarkdown: boolean;
  showPreview: boolean;
  onTogglePreview: () => void;
  fileSizeLabel: string;
  language: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
      <div className="flex items-center gap-2 min-w-0">
        <FileCodeIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-mono text-foreground truncate">{filePath}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
        {isMarkdown && (
          <Button variant="ghost" size="sm" onClick={onTogglePreview} className="h-7 gap-1.5">
            {showPreview ? (
              <FileCodeIcon className="h-3.5 w-3.5" />
            ) : (
              <EyeIcon className="h-3.5 w-3.5" />
            )}
            {showPreview ? 'Code' : 'Preview'}
          </Button>
        )}
        <span>{fileSizeLabel}</span>
        <span className="uppercase">{language}</span>
      </div>
    </div>
  );
}

interface FileViewerWarningsProps {
  truncated: boolean;
  isBinary: boolean;
  fileSizeLabel: string;
}

function FileViewerWarnings({ truncated, fileSizeLabel, isBinary }: FileViewerWarningsProps) {
  return (
    <>
      {truncated && (
        <div className="flex items-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/20">
          <WarningIcon className="h-4 w-4 text-warning" />
          <span className="text-sm text-warning">
            File truncated to 1MB. Actual size: {fileSizeLabel}
          </span>
        </div>
      )}

      {isBinary && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b">
          <WarningIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Binary file cannot be displayed</span>
        </div>
      )}
    </>
  );
}

class MarkdownPreviewErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <WarningCircleIcon className="h-4 w-4 shrink-0" />
          <span>Failed to render preview.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function FileViewerContent({
  data,
  isMarkdown,
  showPreview,
  syntaxTheme,
  onScroll,
  viewportRef,
}: {
  data: FileData;
  isMarkdown: boolean;
  showPreview: boolean;
  syntaxTheme: NonNullable<SyntaxHighlighterProps['style']>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  if (data.isBinary) {
    return (
      <ScrollArea className="flex-1" onScroll={onScroll} viewportRef={viewportRef}>
        <div className="flex items-center justify-center h-full p-8">
          <p className="text-muted-foreground">{data.content}</p>
        </div>
      </ScrollArea>
    );
  }

  if (isMarkdown && showPreview) {
    return (
      <ScrollArea className="flex-1" onScroll={onScroll} viewportRef={viewportRef}>
        <div className="p-4">
          <MarkdownPreviewErrorBoundary>
            <MarkdownRenderer content={data.content} />
          </MarkdownPreviewErrorBoundary>
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="flex-1" onScroll={onScroll} viewportRef={viewportRef} scrollbars="both">
      <FileCode content={data.content} language={data.language} theme={syntaxTheme} />
    </ScrollArea>
  );
}

function FileViewerLoaded({ filePath, tabId, data, syntaxTheme }: FileViewerLoadedProps) {
  const isMarkdown =
    filePath.endsWith('.md') || filePath.endsWith('.markdown') || data.language === 'markdown';

  const [showPreview, setShowPreview] = useState(isMarkdown && !data.isBinary);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const markdownViewportRef = useRef<HTMLDivElement>(null);

  const { handleScroll: handleCodeScroll } = usePersistentScroll({
    tabId,
    mode: 'code',
    viewportRef: codeViewportRef,
    enabled: !showPreview,
    restoreDeps: [showPreview, filePath, data.content.length, data.size, data.isBinary],
  });

  const { handleScroll: handleMarkdownScroll } = usePersistentScroll({
    tabId,
    mode: 'markdown',
    viewportRef: markdownViewportRef,
    enabled: showPreview && isMarkdown,
    restoreDeps: [showPreview, filePath, data.content.length, data.size, data.isBinary],
  });

  const fileSizeLabel = formatFileSize(data.size);
  const onTogglePreview = () => setShowPreview((prev) => !prev);

  return (
    <div className="h-full flex flex-col">
      <FileViewerHeader
        filePath={filePath}
        isMarkdown={isMarkdown && !data.isBinary}
        showPreview={showPreview}
        onTogglePreview={onTogglePreview}
        fileSizeLabel={fileSizeLabel}
        language={data.language}
      />

      <FileViewerWarnings
        truncated={data.truncated}
        isBinary={data.isBinary}
        fileSizeLabel={fileSizeLabel}
      />

      <FileViewerContent
        data={data}
        isMarkdown={isMarkdown}
        showPreview={showPreview}
        syntaxTheme={syntaxTheme}
        onScroll={showPreview ? handleMarkdownScroll : handleCodeScroll}
        viewportRef={showPreview ? markdownViewportRef : codeViewportRef}
      />
    </div>
  );
}

interface SourceBlock {
  firstLine: number;
  lines: string[];
  content: string;
  hasNext: boolean;
  withinByteBudget: boolean;
}

/** A token/visibility update must not replace nodes used by native find or selection. */
function afterTextSelection(element: HTMLElement, update: () => void): () => void {
  const document = element.ownerDocument;
  const apply = () => {
    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(element)
    ) {
      return;
    }
    document.removeEventListener('selectionchange', apply);
    update();
  };
  document.addEventListener('selectionchange', apply);
  apply();
  return () => document.removeEventListener('selectionchange', apply);
}

function SourceBlockView({ block, tokens }: { block: SourceBlock; tokens: LineTokenMap | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [highlight, setHighlight] = useState<{ block: SourceBlock; tokens: LineTokenMap | null }>(
    () => ({ block, tokens: null })
  );
  const displayedTokens = highlight.block === block ? highlight.tokens : null;
  useEffect(() => {
    const next = visible ? tokens : null;
    if (highlight.block === block && highlight.tokens === next) {
      return;
    }
    const element = ref.current;
    if (!element) {
      return;
    }
    return afterTextSelection(element, () =>
      setHighlight((current) => {
        return current.block === block && current.tokens === next
          ? current
          : { block, tokens: next };
      })
    );
  }, [block, tokens, visible, highlight]);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const element = ref.current;
    let cancelPending: (() => void) | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        cancelPending?.();
        cancelPending = afterTextSelection(element, () =>
          setVisible(entry?.isIntersecting ?? false)
        );
      },
      { rootMargin: '300px' }
    );
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      cancelPending?.();
    };
  }, []);
  const renderTokens = (lineTokens: SyntaxToken[]) => {
    let offset = 0;
    return lineTokens.map((token) => {
      const key = offset;
      offset += token.content.length;
      return (
        <span key={key} style={token.style}>
          {token.content}
        </span>
      );
    });
  };
  return (
    <div ref={ref} style={{ display: 'flex', minHeight: `${block.lines.length * 1.5}em` }}>
      <span
        aria-hidden="true"
        className="select-none text-muted-foreground"
        style={{ flexShrink: 0, width: '4em', paddingRight: '1em', textAlign: 'right' }}
      >
        {block.lines.map((_, index) => block.firstLine + index).join('\n')}
      </span>
      <code style={{ fontFamily: 'var(--font-mono)' }}>
        {block.withinByteBudget && displayedTokens?.has(block.firstLine - 1)
          ? block.lines.map((line, index) => {
              const number = block.firstLine + index;
              const lineTokens = displayedTokens.get(number - 1);
              return (
                <span key={number}>
                  {lineTokens ? renderTokens(lineTokens) : line}
                  {index < block.lines.length - 1 || block.hasNext ? '\n' : ''}
                </span>
              );
            })
          : block.content}
      </code>
    </div>
  );
}

/** All source remains in the DOM; only nearby blocks expand into syntax spans. */
export function FileCode({
  content,
  language,
  theme,
}: {
  content: string;
  language: string;
  theme: NonNullable<SyntaxHighlighterProps['style']>;
}) {
  const blocks = useMemo(() => {
    const lines = content.split('\n');
    const result: SourceBlock[] = [];
    for (let index = 0; index < lines.length; index += FILE_HIGHLIGHT_BLOCK_LINES) {
      const block = lines.slice(index, index + FILE_HIGHLIGHT_BLOCK_LINES);
      const blockContent =
        block.join('\n') + (index + FILE_HIGHLIGHT_BLOCK_LINES < lines.length ? '\n' : '');
      result.push({
        withinByteBudget: isFileBlockWithinByteBudget(blockContent),
        firstLine: index + 1,
        lines: block,
        hasNext: index + FILE_HIGHLIGHT_BLOCK_LINES < lines.length,
        content: blockContent,
      });
    }
    return result;
  }, [content]);
  const tokens = useFileHighlighting(
    content,
    language,
    theme,
    blocks.some((block) => block.withinByteBudget)
  );
  return (
    <pre
      style={{
        margin: 0,
        padding: '1rem',
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
      }}
    >
      {blocks.map((block) => (
        <SourceBlockView key={block.firstLine} block={block} tokens={tokens} />
      ))}
    </pre>
  );
}
