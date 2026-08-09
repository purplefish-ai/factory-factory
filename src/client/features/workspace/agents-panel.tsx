import { ProviderSubagentsSection, type SubagentSelection } from '@/client/features/subagents';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

export interface AgentsPanelProps {
  workspaceId: string;
  sessionId: string | null;
  sessionReady: boolean;
  isParentWorkspace: boolean;
  onOpenSubagent: (selection: SubagentSelection) => void;
}

export function AgentsPanel({
  workspaceId,
  sessionId,
  sessionReady,
  isParentWorkspace,
  onOpenSubagent,
}: AgentsPanelProps) {
  return (
    <div className="h-full overflow-y-auto">
      <ProviderSubagentsSection
        sessionId={sessionId}
        enabled={sessionReady}
        onSelect={onOpenSubagent}
      />
      {isParentWorkspace && <ChildWorkspacesPanel workspaceId={workspaceId} embedded />}
    </div>
  );
}
