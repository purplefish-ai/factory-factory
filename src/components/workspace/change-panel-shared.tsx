import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, ChevronDown, ChevronRight, FileCode, Folder, Loader2 } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { FileChangeItem, type FileChangeKind } from './file-change-item';
import { useWorkspacePanel } from './workspace-panel-context';

export interface ChangeListEntry {
  path: string;
  kind: FileChangeKind;
  statusCode?: string;
  showIndicatorDot?: boolean;
}

export interface ChangeSection {
  key: string;
  title: string;
  entries: ChangeListEntry[];
}

interface ChangeListProps {
  entries: ChangeListEntry[];
  onFileClick: (path: string) => void;
  className?: string;
  indicatorLabel?: string;
}

export const ChangeList = memo(function ChangeList({
  entries,
  onFileClick,
  className = 'space-y-0.5',
  indicatorLabel,
}: ChangeListProps) {
  return (
    <div className={className}>
      {entries.map((entry) => (
        <FileChangeItem
          key={entry.path}
          path={entry.path}
          kind={entry.kind}
          statusCode={entry.statusCode}
          showIndicatorDot={entry.showIndicatorDot}
          indicatorLabel={indicatorLabel}
          onClick={() => onFileClick(entry.path)}
        />
      ))}
    </div>
  );
});

interface ChangeSectionsProps {
  sections: ChangeSection[];
  onFileClick: (path: string) => void;
}

export const ChangeSections = memo(function ChangeSections({
  sections,
  onFileClick,
}: ChangeSectionsProps) {
  return (
    <>
      {sections.map((section) => {
        if (section.entries.length === 0) {
          return null;
        }

        return (
          <div key={section.key}>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              {section.title} ({section.entries.length})
            </h3>
            <ChangeList entries={section.entries} onFileClick={onFileClick} />
          </div>
        );
      })}
    </>
  );
});

interface VirtualizedChangeListProps {
  entries: ChangeListEntry[];
  onFileClick: (path: string) => void;
  className?: string;
  contentClassName?: string;
  indicatorLabel?: string;
}

export const VirtualizedChangeList = memo(function VirtualizedChangeList({
  entries,
  onFileClick,
  className,
  contentClassName,
  indicatorLabel,
}: VirtualizedChangeListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className={cn('h-full overflow-auto', className)}>
      <div
        className={contentClassName}
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const entry = entries[virtualItem.index];
          if (!entry) {
            return null;
          }
          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <FileChangeItem
                path={entry.path}
                kind={entry.kind}
                statusCode={entry.statusCode}
                showIndicatorDot={entry.showIndicatorDot}
                indicatorLabel={indicatorLabel}
                onClick={() => onFileClick(entry.path)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

export function useOpenDiffTab() {
  const { openTab } = useWorkspacePanel();
  return useCallback(
    (path: string) => {
      openTab('diff', path, `Diff: ${path.split('/').pop()}`);
    },
    [openTab]
  );
}

export function PanelLoadingState() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

interface PanelErrorStateProps {
  title: string;
  errorMessage?: string;
}

export function PanelErrorState({ title, errorMessage }: PanelErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-4">
      <AlertCircle className="h-8 w-8 text-destructive mb-2" />
      <p className="text-sm text-destructive">{title}</p>
      {errorMessage && <p className="text-xs text-muted-foreground mt-1">{errorMessage}</p>}
    </div>
  );
}

interface PanelEmptyStateProps {
  title: string;
  description: string;
}

export function PanelEmptyState({ title, description }: PanelEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-4">
      <FileCode className="h-8 w-8 text-muted-foreground mb-2" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/70 mt-1">{description}</p>
    </div>
  );
}

interface ScrollableChangeSectionsProps {
  sections: ChangeSection[];
  onFileClick: (path: string) => void;
  className?: string;
  beforeSections?: React.ReactNode;
}

export function ScrollableChangeSections({
  sections,
  onFileClick,
  className = 'p-2 space-y-3',
  beforeSections,
}: ScrollableChangeSectionsProps) {
  return (
    <ScrollArea className="h-full">
      <div className={className}>
        {beforeSections}
        <ChangeSections sections={sections} onFileClick={onFileClick} />
      </div>
    </ScrollArea>
  );
}

// =============================================================================
// Change Tree View
// =============================================================================

export interface ChangeTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  /** Present for actual changed items. Undefined for virtual directory nodes (inferred from file paths). */
  entry?: ChangeListEntry;
  children: ChangeTreeNode[];
}

/**
 * Build a tree from a flat list of change entries.
 * - Paths ending with '/' are git-reported untracked directories (rendered as folder nodes).
 * - Other paths are files grouped under virtual directory nodes derived from their path segments.
 * - All directories start expanded by default.
 */
export function buildChangeTree(entries: ChangeListEntry[]): ChangeTreeNode[] {
  const root: ChangeTreeNode[] = [];
  // Maps a directory path to its children array (for virtual dirs only)
  const dirChildrenMap = new Map<string, ChangeTreeNode[]>();

  function ensureVirtualDirChain(dirPath: string): ChangeTreeNode[] {
    const existing = dirChildrenMap.get(dirPath);
    if (existing) {
      return existing;
    }
    const lastSlash = dirPath.lastIndexOf('/');
    const parentList = lastSlash === -1 ? root : ensureVirtualDirChain(dirPath.slice(0, lastSlash));
    const name = lastSlash === -1 ? dirPath : dirPath.slice(lastSlash + 1);
    const node: ChangeTreeNode = { name, path: dirPath, type: 'directory', children: [] };
    dirChildrenMap.set(dirPath, node.children);
    parentList.push(node);
    return node.children;
  }

  for (const entry of entries) {
    const { path } = entry;
    // Git reports untracked directories with a trailing slash (e.g. "newfolder/")
    const isGitDir = path.endsWith('/');
    const normalPath = isGitDir ? path.slice(0, -1) : path;
    const lastSlash = normalPath.lastIndexOf('/');
    const name = lastSlash === -1 ? normalPath : normalPath.slice(lastSlash + 1);
    const parentList =
      lastSlash === -1 ? root : ensureVirtualDirChain(normalPath.slice(0, lastSlash));

    parentList.push({
      name,
      path: normalPath,
      type: isGitDir ? 'directory' : 'file',
      entry,
      children: [],
    });
  }

  // Sort each level: directories before files, then alphabetically
  function sortNodes(nodes: ChangeTreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    }
  }
  sortNodes(root);

  return root;
}

interface FlatChangeItem {
  node: ChangeTreeNode;
  depth: number;
  isExpanded: boolean;
}

function flattenChangeTree(
  nodes: ChangeTreeNode[],
  depth: number,
  collapsedDirs: Set<string>,
  result: FlatChangeItem[] = []
): FlatChangeItem[] {
  for (const node of nodes) {
    const isExpanded =
      node.type === 'directory' && node.children.length > 0 && !collapsedDirs.has(node.path);
    result.push({ node, depth, isExpanded });
    if (isExpanded) {
      flattenChangeTree(node.children, depth + 1, collapsedDirs, result);
    }
  }
  return result;
}

/**
 * Recursively renders the contents of a git-reported untracked directory.
 * Fetches children via listFiles and renders them as untracked file/dir items.
 */
function UntrackedDirContents({
  workspaceId,
  dirPath,
  depth,
  onFileClick,
}: {
  workspaceId: string;
  dirPath: string;
  depth: number;
  onFileClick: (path: string) => void;
}) {
  const { data, isLoading, isError } = trpc.workspace.listFiles.useQuery(
    { workspaceId, path: dirPath },
    { staleTime: 20_000, refetchOnWindowFocus: false }
  );

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1 text-xs text-destructive"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>Failed to load directory contents</span>
      </div>
    );
  }

  const entries = data?.entries ?? [];
  return (
    <>
      {entries.map((entry) =>
        entry.type === 'directory' ? (
          <UntrackedSubDir
            key={entry.path}
            name={entry.name}
            dirPath={entry.path}
            depth={depth}
            workspaceId={workspaceId}
            onFileClick={onFileClick}
          />
        ) : (
          <div key={entry.path} style={{ paddingLeft: `${depth * 12}px` }}>
            <FileChangeItem
              path={entry.path}
              kind="untracked"
              statusCode="?"
              showDirPath={false}
              onClick={() => onFileClick(entry.path)}
            />
          </div>
        )
      )}
    </>
  );
}

/** A sub-directory inside an untracked directory — expandable, starts expanded. */
function UntrackedSubDir({
  name,
  dirPath,
  depth,
  workspaceId,
  onFileClick,
}: {
  name: string;
  dirPath: string;
  depth: number;
  workspaceId: string;
  onFileClick: (path: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
          'hover:bg-muted/50 rounded-md transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={`Untracked: ${dirPath}`}
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-medium">{name}</span>
      </button>
      {isExpanded && (
        <UntrackedDirContents
          workspaceId={workspaceId}
          dirPath={dirPath}
          depth={depth + 1}
          onFileClick={onFileClick}
        />
      )}
    </div>
  );
}

/** A git-reported untracked directory (path ending with '/') — expands via listFiles. */
const GitReportedDirRow = memo(function GitReportedDirRow({
  node,
  depth,
  workspaceId,
  onFileClick,
}: {
  node: ChangeTreeNode;
  depth: number;
  workspaceId: string;
  onFileClick: (path: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
          'hover:bg-muted/50 rounded-md transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={`Untracked: ${node.path}`}
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-medium">{node.name}</span>
        {node.entry && (
          <span className="text-xs font-mono uppercase text-muted-foreground">
            {node.entry.statusCode ?? '?'}
          </span>
        )}
      </button>
      {isExpanded && (
        <UntrackedDirContents
          workspaceId={workspaceId}
          dirPath={node.path}
          depth={depth + 1}
          onFileClick={onFileClick}
        />
      )}
    </div>
  );
});

interface ChangeTreeItemRowProps {
  node: ChangeTreeNode;
  depth: number;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  workspaceId?: string;
  indicatorLabel?: string;
}

const ChangeTreeItemRow = memo(function ChangeTreeItemRow({
  node,
  depth,
  isExpanded,
  onToggle,
  onFileClick,
  workspaceId,
  indicatorLabel,
}: ChangeTreeItemRowProps) {
  if (node.type === 'file' && node.entry) {
    return (
      <div style={{ paddingLeft: `${depth * 12}px` }}>
        <FileChangeItem
          path={node.path}
          kind={node.entry.kind}
          statusCode={node.entry.statusCode}
          showIndicatorDot={node.entry.showIndicatorDot}
          indicatorLabel={indicatorLabel}
          showDirPath={false}
          onClick={() => onFileClick(node.path)}
        />
      </div>
    );
  }

  // Git-reported untracked directory: delegate to self-contained component that fetches children
  const isGitReported = !!node.entry;
  if (isGitReported && workspaceId) {
    return (
      <GitReportedDirRow
        node={node}
        depth={depth}
        workspaceId={workspaceId}
        onFileClick={onFileClick}
      />
    );
  }

  // Virtual directory (inferred from file paths) — uses parent's expand/collapse state
  return (
    <button
      type="button"
      onClick={() => onToggle(node.path)}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
        'hover:bg-muted/50 rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      title={node.path}
    >
      {isExpanded ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}
      <Folder className="h-4 w-4 shrink-0 text-brand" />
      <span className="flex-1 truncate font-medium">{node.name}</span>
    </button>
  );
});

interface ChangeTreeViewProps {
  entries: ChangeListEntry[];
  onFileClick: (path: string) => void;
  className?: string;
  indicatorLabel?: string;
  workspaceId?: string;
  /** When true, virtualizes the flattened tree rows for large change sets. */
  virtualized?: boolean;
}

export const ChangeTreeView = memo(function ChangeTreeView({
  entries,
  onFileClick,
  className = 'space-y-0.5',
  indicatorLabel,
  workspaceId,
  virtualized = false,
}: ChangeTreeViewProps) {
  const tree = useMemo(() => buildChangeTree(entries), [entries]);
  // Track collapsed dirs (all start expanded — only explicitly collapsed ones are stored)
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const flatItems = useMemo(() => flattenChangeTree(tree, 0, collapsedDirs), [tree, collapsedDirs]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
    enabled: virtualized,
  });

  if (virtualized) {
    return (
      <div ref={parentRef} className="h-full overflow-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatItems[virtualItem.index];
            if (!item) {
              return null;
            }
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <ChangeTreeItemRow
                  node={item.node}
                  depth={item.depth}
                  isExpanded={item.isExpanded}
                  onToggle={toggleDir}
                  onFileClick={onFileClick}
                  workspaceId={workspaceId}
                  indicatorLabel={indicatorLabel}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {flatItems.map(({ node, depth, isExpanded }) => (
        <ChangeTreeItemRow
          key={node.path}
          node={node}
          depth={depth}
          isExpanded={isExpanded}
          onToggle={toggleDir}
          onFileClick={onFileClick}
          workspaceId={workspaceId}
          indicatorLabel={indicatorLabel}
        />
      ))}
    </div>
  );
});
