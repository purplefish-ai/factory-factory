import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, FileCode, Loader2 } from 'lucide-react';
import { memo, useCallback, useRef } from 'react';

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
