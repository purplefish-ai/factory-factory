import { ProviderSubagentsSection, type SubagentSelection } from '@/client/features/subagents';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

export interface AgentsPanelProps {
  workspaceId: string;
  sessionId: string | null;
  sessionName: string | null;
  sessionReady: boolean;
  isParentWorkspace: boolean;
  onOpenSubagent: (selection: SubagentSelection) => void;
}

export function AgentsPanel({
  workspaceId,
  sessionId,
  sessionName,
  sessionReady,
  isParentWorkspace,
  onOpenSubagent,
}: AgentsPanelProps) {
  return (
    <div className="h-full overflow-y-auto">
      <ProviderSubagentsSection
        key={sessionId ?? 'no-session'}
        sessionId={sessionId}
        parentSessionName={sessionName}
        enabled={sessionReady}
        onSelect={onOpenSubagent}
      />
      {isParentWorkspace && <ChildWorkspacesPanel workspaceId={workspaceId} embedded />}
    </div>
  );
}
