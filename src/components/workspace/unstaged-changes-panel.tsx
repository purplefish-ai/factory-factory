import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

import {
  ChangeList,
  type ChangeListEntry,
  PanelEmptyState,
  PanelErrorState,
  PanelLoadingState,
  useOpenDiffTab,
  VirtualizedChangeList,
} from './change-panel-shared';
import { fileChangeKindFromGitStatus } from './file-change-item';

// =============================================================================
// Types
// =============================================================================

interface UnstagedChangesPanelProps {
  workspaceId: string;
}

// =============================================================================
// Main Component
// =============================================================================

export function UnstagedChangesPanel({ workspaceId }: UnstagedChangesPanelProps) {
  const openDiffTab = useOpenDiffTab();

  const { data, isLoading, error } = trpc.workspace.getUnstagedChanges.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  if (isLoading) {
    return <PanelLoadingState />;
  }

  if (error) {
    return <PanelErrorState title="Failed to load unstaged changes" errorMessage={error.message} />;
  }

  const files = data?.files ?? [];
  if (files.length === 0) {
    return (
      <PanelEmptyState
        title="No unstaged changes"
        description="All changes are staged or committed"
      />
    );
  }

  const entries: ChangeListEntry[] = files.map((file) => ({
    path: file.path,
    kind: fileChangeKindFromGitStatus(file.status),
    statusCode: file.status,
  }));

  // Use virtualization for large lists
  if (entries.length > 200) {
    return (
      <VirtualizedChangeList entries={entries} onFileClick={openDiffTab} contentClassName="p-2" />
    );
  }

  // For smaller lists, render normally without virtualization
  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <ChangeList entries={entries} onFileClick={openDiffTab} />
      </div>
    </ScrollArea>
  );
}
