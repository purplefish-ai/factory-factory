import { ProviderSubagentsSection, type SubagentSelection } from '@/client/features/subagents';
import { useUserSettings } from '@/client/lib/user-settings-queries';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

export interface AgentsPanelProps {
  workspaceId: string;
  sessionId: string | null;
  sessionName: string | null;
  sessionReady: boolean;
  controlSessionId?: string;
  controlRuntimeId?: string;
  isParentWorkspace: boolean;
  onOpenSubagent: (selection: SubagentSelection) => void;
}

export function AgentsPanel({
  workspaceId,
  sessionId,
  sessionName,
  sessionReady,
  controlSessionId,
  controlRuntimeId,
  isParentWorkspace,
  onOpenSubagent,
}: AgentsPanelProps) {
  const { data: settings } = useUserSettings({
    enabled: isParentWorkspace,
  });
  return (
    <div className="h-full overflow-y-auto">
      <ProviderSubagentsSection
        key={sessionId ?? 'no-session'}
        sessionId={sessionId}
        parentSessionName={sessionName}
        enabled={sessionReady}
        controlSessionId={controlSessionId}
        controlRuntimeId={controlRuntimeId}
        onSelect={onOpenSubagent}
      />
      {isParentWorkspace && settings?.childWorkspacesEnabled && (
        <ChildWorkspacesPanel workspaceId={workspaceId} embedded />
      )}
    </div>
  );
}
