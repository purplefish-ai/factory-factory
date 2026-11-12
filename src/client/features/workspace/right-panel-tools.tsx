import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { FileDashedIcon } from '@phosphor-icons/react/dist/csr/FileDashed';
import { FilesIcon } from '@phosphor-icons/react/dist/csr/Files';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { WorkspaceInboxPanel, UnreadMailBadge } from '@/client/features/inbox';
import type { SubagentSelection } from '@/client/features/subagents';
import { TabButton, TabList } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AgentsPanel } from './agents-panel';
import { AutomationOriginPanel } from './automation-origin-panel';
import { CombinedChangesPanel } from './combined-changes-panel';
import { FileBrowserPanel } from './file-browser-panel';
import { PeriodicTaskPanel } from './periodic-task-panel';
import type { TopPanelTab } from './right-panel-state';
import { ScreenshotsPanel } from './screenshots-panel';

interface TopPanelAreaProps {
  compact?: boolean;
  unreadCount?: number;
  workspaceId: string;
  projectId?: string;
  activeTopTab: TopPanelTab;
  onTopTabChange: (tab: TopPanelTab) => void;
  isTakingScreenshots: boolean;
  onTakeScreenshots?: () => void;
  periodicTaskId: string | null;
  /** An event-run workspace whose origin run is retained (or still loading). */
  hasEventOrigin: boolean;
  isParentWorkspace: boolean;
  selectedSessionId: string | null;
  selectedSessionName: string | null;
  selectedSessionReady: boolean;
  selectedSessionControlId?: string;
  selectedSessionControlRuntimeId?: string;
  onOpenSubagent: (selection: SubagentSelection) => void;
}

export function TopPanelArea({
  compact,
  unreadCount,
  workspaceId,
  projectId,
  activeTopTab,
  onTopTabChange,
  isTakingScreenshots,
  onTakeScreenshots,
  periodicTaskId,
  hasEventOrigin,
  isParentWorkspace,
  selectedSessionId,
  selectedSessionName,
  selectedSessionReady,
  selectedSessionControlId,
  selectedSessionControlRuntimeId,
  onOpenSubagent,
}: TopPanelAreaProps) {
  const showChanges = activeTopTab === 'changes';
  const showFiles = activeTopTab === 'files';
  const showScreenshots = activeTopTab === 'screenshots';
  const hasRuns = !!periodicTaskId || hasEventOrigin;
  const showRuns = hasRuns && activeTopTab === 'periodic-task';
  const showInbox = activeTopTab === 'inbox';
  const showAgents = activeTopTab === 'agents';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <TabList
        aria-label="Workspace tools"
        hidden={compact}
        className={cn(
          'gap-0.5 p-1 bg-shell border-b overflow-x-auto shrink-0',
          compact && 'hidden'
        )}
        data-testid="workspace-tools-toolbar"
      >
        <TabButton
          label="Changes"
          icon={<FileDashedIcon className="h-3.5 w-3.5" />}
          isActive={showChanges}
          onSelect={() => onTopTabChange('changes')}
        />
        <TabButton
          label="Files"
          icon={<FilesIcon className="h-3.5 w-3.5" />}
          isActive={showFiles}
          onSelect={() => onTopTabChange('files')}
        />
        {hasRuns && (
          <TabButton
            label="Runs"
            icon={<RobotIcon className="h-3.5 w-3.5" />}
            isActive={showRuns}
            onSelect={() => onTopTabChange('periodic-task')}
          />
        )}
        <TabButton
          label="Subagents"
          icon={<TreeStructureIcon className="h-3.5 w-3.5" />}
          isActive={showAgents}
          onSelect={() => onTopTabChange('agents')}
        />

        <TabButton
          label="Inbox"
          icon={
            <span className="inline-flex items-center gap-1">
              <EnvelopeSimpleIcon className="h-3.5 w-3.5" />
              <UnreadMailBadge count={unreadCount} icon={false} />
            </span>
          }
          isActive={showInbox}
          onSelect={() => onTopTabChange('inbox')}
        />
        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <TabButton
                label="Screenshots"
                hideLabel
                icon={<CameraIcon className="h-3.5 w-3.5" />}
                isActive={showScreenshots}
                onSelect={() => onTopTabChange('screenshots')}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>Screenshots</TooltipContent>
        </Tooltip>
      </TabList>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {showInbox && <WorkspaceInboxPanel workspaceId={workspaceId} />}
        {showChanges && <CombinedChangesPanel workspaceId={workspaceId} />}
        {showFiles && <FileBrowserPanel workspaceId={workspaceId} />}
        {showScreenshots && (
          <ScreenshotsPanel
            workspaceId={workspaceId}
            isTakingScreenshots={isTakingScreenshots}
            onTakeScreenshots={onTakeScreenshots}
          />
        )}
        {showRuns && periodicTaskId && (
          <PeriodicTaskPanel periodicTaskId={periodicTaskId} projectId={projectId} />
        )}
        {showRuns && !periodicTaskId && projectId && (
          <AutomationOriginPanel workspaceId={workspaceId} projectId={projectId} />
        )}
        {showAgents && (
          <AgentsPanel
            workspaceId={workspaceId}
            sessionId={selectedSessionId}
            sessionName={selectedSessionName}
            sessionReady={selectedSessionReady}
            controlSessionId={selectedSessionControlId}
            controlRuntimeId={selectedSessionControlRuntimeId}
            isParentWorkspace={isParentWorkspace}
            onOpenSubagent={onOpenSubagent}
          />
        )}
      </div>
    </div>
  );
}
