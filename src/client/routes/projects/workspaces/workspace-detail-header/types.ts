import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import type { useSessionManagement, useWorkspaceData } from '../use-workspace-detail';

export type WorkspaceHeaderWorkspace = NonNullable<
  ReturnType<typeof useWorkspaceData>['workspace']
>;
export type WorkspaceSessionManagement = ReturnType<typeof useSessionManagement>;

export type WorkspacePrChipProps = {
  prUrl: NonNullable<WorkspaceHeaderWorkspace['prUrl']>;
  prNumber: NonNullable<WorkspaceHeaderWorkspace['prNumber']>;
  isMerged: boolean;
  className?: string;
};

export type WorkspaceSwitchGroups = {
  todo: ServerWorkspace[];
  waiting: ServerWorkspace[];
  working: ServerWorkspace[];
  done: ServerWorkspace[];
};

export interface WorkspaceHeaderProps {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  availableIdes: WorkspaceSessionManagement['availableIdes'];
  preferredIde: WorkspaceSessionManagement['preferredIde'];
  openInIde: WorkspaceSessionManagement['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
  handleQuickAction: WorkspaceSessionManagement['handleQuickAction'];
  running: boolean;
  isCreatingSession: boolean;
  hasChanges?: boolean;
}
