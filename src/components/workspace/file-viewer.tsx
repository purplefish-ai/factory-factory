import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, AlertTriangle, Eye, FileCode, Loader2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { RefObject, UIEvent } from 'react';
import { useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AppRouter } from '@/frontend/lib/trpc';
import { trpc } from '@/frontend/lib/trpc';
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

  const syntaxTheme = resolvedTheme === 'dark' ? oneDark : oneLight;

  return (
    <FileViewerLoaded filePath={filePath} tabId={tabId} data={data} syntaxTheme={syntaxTheme} />
  );
}

interface FileViewerLoadedProps {
  filePath: string;
  tabId: string;
  data: FileData;
  syntaxTheme: typeof oneDark;
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
        <FileCode className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-mono text-foreground truncate">{filePath}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
        {isMarkdown && (
          <Button variant="ghost" size="sm" onClick={onTogglePreview} className="h-7 gap-1.5">
            {showPreview ? <FileCode className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span className="text-sm text-warning">
            File truncated to 1MB. Actual size: {fileSizeLabel}
          </span>
        </div>
      )}

      {isBinary && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Binary file cannot be displayed</span>
        </div>
      )}
    </>
  );
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
  syntaxTheme: typeof oneDark;
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
          <MarkdownRenderer content={data.content} />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="flex-1" onScroll={onScroll} viewportRef={viewportRef}>
      <SyntaxHighlighter
        language={data.language}
        style={syntaxTheme}
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
    </ScrollArea>
  );
}

function FileViewerLoaded({ filePath, tabId, data, syntaxTheme }: FileViewerLoadedProps) {
  const [showPreview, setShowPreview] = useState(false);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const markdownViewportRef = useRef<HTMLDivElement>(null);

  const isMarkdown =
    filePath.endsWith('.md') || filePath.endsWith('.markdown') || data.language === 'markdown';

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
