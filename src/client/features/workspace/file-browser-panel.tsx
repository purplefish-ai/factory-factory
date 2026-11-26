import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useCallback, useRef, useState } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { IconButton } from '@/client/components/icon-button';
import { Loading } from '@/client/components/loading';
import { QueryState } from '@/client/components/query-state';
import { useDebouncedValue } from '@/client/hooks/use-debounced-value';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileTree, getFileIcon, NoWorkspaceFiles } from './file-tree';
import { FileTreeProvider } from './file-tree-context';
import { FileTreeRow } from './file-tree-row';
import { useWorkspacePanelActions } from './workspace-panel-context';

interface FileBrowserPanelProps {
  workspaceId: string;
}

export function FileBrowserPanel({ workspaceId }: FileBrowserPanelProps) {
  return <WorkspaceFiles key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceFiles({ workspaceId }: FileBrowserPanelProps) {
  const { openTab } = useWorkspacePanelActions();
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const searchTerm = filter.trim();
  const query = useDebouncedValue(searchTerm, 200, { immediate: !searchTerm });

  const handleFileSelect = useCallback(
    (path: string, name: string) => {
      openTab('file', path, name);
    },
    [openTab]
  );

  const handleRefresh = useCallback(() => {
    runInBackground(
      Promise.all([
        utils.workspace.listFiles.invalidate({ workspaceId }),
        utils.workspace.listAllFiles.invalidate({ workspaceId, match: 'fuzzy' }),
      ]),
      "Couldn't refresh files."
    );
  }, [utils, workspaceId]);

  return (
    <FileTreeProvider workspaceId={workspaceId}>
      <div className="h-full flex flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              aria-label="Search files"
              placeholder="Search files…"
              autoComplete="off"
              spellCheck={false}
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter && !event.nativeEvent.isComposing) {
                  event.stopPropagation();
                  setFilter('');
                }
              }}
              className="pr-8 pl-8 md:h-7 md:text-xs"
            />
            {filter && (
              <IconButton
                label="Clear file search"
                size="icon-xs"
                className="absolute top-1/2 right-0.5 -translate-y-1/2"
                onClick={() => {
                  setFilter('');
                  inputRef.current?.focus();
                }}
              >
                <XIcon />
              </IconButton>
            )}
          </div>
          <IconButton
            label={searchTerm ? 'Refresh file search' : 'Refresh file tree'}
            size="icon-xs"
            onClick={handleRefresh}
          >
            <ArrowsClockwiseIcon />
          </IconButton>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-1">
            {!searchTerm && <FileTree workspaceId={workspaceId} onFileSelect={handleFileSelect} />}
            {searchTerm !== query && <Loading size="compact" message="Searching files…" />}
            {searchTerm && searchTerm === query && (
              <FileSearchResults
                workspaceId={workspaceId}
                query={query}
                onFileSelect={handleFileSelect}
              />
            )}
          </div>
        </ScrollArea>
      </div>
    </FileTreeProvider>
  );
}

function FileSearchResults({
  workspaceId,
  query,
  onFileSelect,
}: FileBrowserPanelProps & {
  query: string;
  onFileSelect: (path: string, name: string) => void;
}) {
  const results = trpc.workspace.listAllFiles.useQuery(
    { workspaceId, query, match: 'fuzzy' },
    {
      trpc: { abortOnUnmount: true },
      // Reuse recent queries when typing back through a filename. Refresh invalidates them.
      staleTime: 20_000,
    }
  );

  return (
    <QueryState
      query={results}
      size="compact"
      loadingMessage="Searching files…"
      errorTitle="Couldn't search files"
      isEmpty={({ files }) => files.length === 0}
      empty={
        results.data?.hasWorktree === false ? (
          <NoWorkspaceFiles />
        ) : (
          <EmptyState size="compact" title="No matching files" />
        )
      }
    >
      {({ files }) => (
        <ul aria-label="File search results">
          {files.map((path) => {
            const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
            const name = path.slice(separator + 1);
            const directory = path.slice(0, Math.max(0, separator));
            return (
              <li key={path}>
                <FileTreeRow
                  title={path}
                  icon={<span className="text-muted-foreground">{getFileIcon(name)}</span>}
                  label={
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate">{name}</span>
                      {directory && (
                        <span className="max-w-1/2 truncate text-xs text-muted-foreground">
                          {directory}
                        </span>
                      )}
                    </span>
                  }
                  onClick={() => onFileSelect(path, name)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </QueryState>
  );
}
