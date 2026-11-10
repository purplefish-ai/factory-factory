import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import type { inferRouterOutputs } from '@trpc/server';
import { useTheme } from 'next-themes';
import type { RefObject, UIEvent } from 'react';
import { useRef, useState } from 'react';
import { QueryState } from '@/client/components/query-state';
import { StatusCallout } from '@/client/components/status-callout';
import { ErrorBoundary } from '@/client/error-boundary';
import type { AppRouter } from '@/client/lib/trpc';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatBytes } from '@/lib/formatters';
import { FileCode } from './file-code';
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
// Main Component
// =============================================================================

export function FileViewer({ workspaceId, filePath, tabId }: FileViewerProps) {
  const { resolvedTheme } = useTheme();
  const query = trpc.workspace.readFile.useQuery({
    workspaceId,
    path: filePath,
  });
  const syntaxTheme = resolvedTheme === 'dark' ? 'dark' : 'light';

  // A refresh notice sits above the loaded file, so the file fills the rest of the column.
  return (
    <div className="flex h-full flex-col">
      <QueryState
        query={query}
        errorTitle="Couldn't load file"
        loadingMessage="Loading file…"
        className="h-full"
      >
        {(data) => (
          <FileViewerLoaded
            filePath={filePath}
            tabId={tabId}
            data={data}
            syntaxTheme={syntaxTheme}
          />
        )}
      </QueryState>
    </div>
  );
}

interface FileViewerLoadedProps {
  filePath: string;
  tabId: string;
  data: FileData;
  syntaxTheme: 'dark' | 'light';
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
        <StatusCallout tone="warning" variant="strip" className="px-4">
          File truncated to 1MB. Actual size: {fileSizeLabel}
        </StatusCallout>
      )}

      {isBinary && (
        <StatusCallout tone="neutral" variant="strip" icon={WarningIcon} className="px-4">
          Binary file cannot be displayed
        </StatusCallout>
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
  syntaxTheme: 'dark' | 'light';
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
          <ErrorBoundary
            variant="compact"
            title="Couldn't render the preview"
            resetKey={data.content}
          >
            <MarkdownRenderer content={data.content} />
          </ErrorBoundary>
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

  const fileSizeLabel = formatBytes(data.size, { precision: 1 });
  const onTogglePreview = () => setShowPreview((prev) => !prev);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
