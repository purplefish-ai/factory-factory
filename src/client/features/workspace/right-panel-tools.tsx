import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileDashedIcon } from '@phosphor-icons/react/dist/csr/FileDashed';
import { FilesIcon } from '@phosphor-icons/react/dist/csr/Files';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import type { SubagentSelection } from '@/client/features/subagents';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AgentsPanel } from './agents-panel';
import { CombinedChangesPanel } from './combined-changes-panel';
import { FileBrowserPanel } from './file-browser-panel';
import { PeriodicTaskPanel } from './periodic-task-panel';
import type { TopPanelTab } from './right-panel-state';
import { ScreenshotsPanel } from './screenshots-panel';

interface TopPanelAreaProps {
  compact?: boolean;
  workspaceId: string;
  projectId?: string;
  activeTopTab: TopPanelTab;
  onTopTabChange: (tab: TopPanelTab) => void;
  isTakingScreenshots: boolean;
  onTakeScreenshots?: () => void;
  periodicTaskId: string | null;
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
  workspaceId,
  projectId,
  activeTopTab,
  onTopTabChange,
  isTakingScreenshots,
  onTakeScreenshots,
  periodicTaskId,
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
  const showPeriodicTask = !!periodicTaskId && activeTopTab === 'periodic-task';
  const showAgents = activeTopTab === 'agents';

  const screenshotsButtonClassName = cn(
    'h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md transition-colors',
    showScreenshots
      ? 'bg-background text-foreground shadow-sm border border-border'
      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border border-transparent'
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div
        hidden={compact}
        className={cn('flex items-center gap-0.5 p-1 bg-muted/50 border-b', compact && 'hidden')}
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
        {periodicTaskId && (
          <TabButton
            label="Agent"
            icon={<RobotIcon className="h-3.5 w-3.5" />}
            isActive={showPeriodicTask}
            onSelect={() => onTopTabChange('periodic-task')}
          />
        )}
        <TabButton
          label="Sessions"
          icon={<TreeStructureIcon className="h-3.5 w-3.5" />}
          isActive={showAgents}
          onSelect={() => onTopTabChange('agents')}
        />

        <div className="flex-1" />

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onTopTabChange('screenshots')}
                className={screenshotsButtonClassName}
                aria-label="Screenshots"
              >
                <CameraIcon className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Screenshots</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {showChanges && <CombinedChangesPanel workspaceId={workspaceId} />}
        {showFiles && <FileBrowserPanel workspaceId={workspaceId} />}
        {showScreenshots && (
          <ScreenshotsPanel
            workspaceId={workspaceId}
            isTakingScreenshots={isTakingScreenshots}
            onTakeScreenshots={onTakeScreenshots}
          />
        )}
        {showPeriodicTask && periodicTaskId && (
          <PeriodicTaskPanel periodicTaskId={periodicTaskId} projectId={projectId} />
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
