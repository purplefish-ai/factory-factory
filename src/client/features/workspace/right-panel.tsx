import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { SubagentSelection } from '@/client/features/subagents';
import { useWorkspaceDetailQuery } from '@/client/hooks/use-workspace-detail-query';
import { useWorkspaceDrawer } from '@/client/hooks/use-workspace-drawer';
import { trpc } from '@/client/lib/trpc';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DevLogsPanel } from './dev-logs-panel';
import { RightPanelLayout } from './right-panel-layout';
import { STORAGE_KEY_TOP_TAB_PREFIX } from './right-panel-state';
import { TopPanelArea } from './right-panel-tools';
import { SetupLogsPanel } from './setup-logs-panel';
import { TerminalPanel, type TerminalPanelRef, type TerminalTabState } from './terminal-panel';
import { TerminalTabBar } from './terminal-tab-bar';
import { useLogStream } from './use-log-stream';
import { type BottomPanelTab, useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

type LogsBottomTab = Exclude<BottomPanelTab, 'terminal'>;

function isLogsBottomTab(tab: BottomPanelTab): tab is LogsBottomTab {
  return tab === 'setup-logs' || tab === 'dev-logs' || tab === 'post-run-logs';
}

// =============================================================================
// Main Component
// =============================================================================

interface RightPanelProps {
  workspaceId: string;
  className?: string;
  isTakingScreenshots?: boolean;
  onTakeScreenshots?: () => Promise<void>;
  selectedSessionId?: string | null;
  selectedSessionName?: string | null;
  selectedSessionReady?: boolean;
  selectedSessionControlId?: string;
  selectedSessionControlRuntimeId?: string;
  onOpenSubagent?: (selection: SubagentSelection) => void;
}

export const RightPanel = memo(function RightPanel({
  workspaceId,
  className,
  isTakingScreenshots = false,
  onTakeScreenshots,
  selectedSessionId = null,
  selectedSessionName = null,
  selectedSessionReady = false,
  selectedSessionControlId,
  selectedSessionControlRuntimeId,
  onOpenSubagent = () => undefined,
}: RightPanelProps) {
  // Track which workspaceId has been loaded to handle workspace changes
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const {
    mobilePanel,
    activeBottomTab,
    setActiveBottomTab,
    activeTopTab,
    setActiveTopTab: handleTopTabChange,
  } = useWorkspacePanel();
  const isMobile = useWorkspaceDrawer();
  const terminalPanelRef = useRef<TerminalPanelRef>(null);

  // Single shared dev logs connection for both tab indicator and panel content
  const devLogs = useLogStream('/dev-logs', workspaceId, activeBottomTab === 'dev-logs');
  const postRunLogs = useLogStream(
    '/post-run-logs',
    workspaceId,
    activeBottomTab === 'post-run-logs'
  );

  // Terminal tab state lifted up from TerminalPanel for inline rendering
  const [terminalTabState, setTerminalTabState] = useState<TerminalTabState | null>(null);

  // Track last selected logs subtab for Logs tab navigation
  const [lastLogsTab, setLastLogsTab] = useState<LogsBottomTab>('setup-logs');

  const handleTerminalStateChange = useCallback((state: TerminalTabState) => {
    setTerminalTabState(state);
  }, []);

  const { data: workspace } = useWorkspaceDetailQuery(workspaceId);
  const periodicTaskId =
    (workspace as { periodicTaskId?: string | null } | undefined)?.periodicTaskId ?? null;
  const creationSource =
    (workspace as { creationSource?: string | null } | undefined)?.creationSource ?? null;
  // Child-workspace eligibility is unknown until the workspace query resolves.
  const isParentWorkspace = workspace !== undefined && creationSource !== 'CHILD_WORKSPACE';

  const { data: initStatus } = trpc.workspace.getInitStatus.useQuery(
    { id: workspaceId },
    {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === 'READY' ||
          status === 'FAILED' ||
          status === 'ARCHIVING' ||
          status === 'ARCHIVED'
          ? false
          : 1000;
      },
    }
  );

  // Reset workspace-specific terminal and log state on mount or workspace change.
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

    // Reset terminal tab state when workspace changes
    setTerminalTabState(null);

    // Reset logs subtab selection to default when workspace changes
    setLastLogsTab('setup-logs');
  }, [workspaceId]);

  useEffect(() => {
    if (workspace === undefined) {
      return;
    }
    if (activeTopTab === 'periodic-task' && !periodicTaskId) {
      handleTopTabChange('changes');
    }
  }, [workspace, activeTopTab, periodicTaskId, handleTopTabChange]);

  const handleTakeScreenshots = useCallback(() => {
    handleTopTabChange('screenshots');
    void onTakeScreenshots?.();
  }, [handleTopTabChange, onTakeScreenshots]);

  // Auto-select the periodic-task tab on first load,
  // but only when the user has no persisted tab preference for this workspace.
  const periodicTaskTabSelectedRef = useRef(false);
  const prevWorkspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      prevWorkspaceIdRef.current = workspaceId;
      periodicTaskTabSelectedRef.current = false;
    }
    const hasPersistedTabCheck = () => {
      if (typeof window === 'undefined') {
        return false;
      }
      try {
        return localStorage.getItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`) != null;
      } catch {
        return false;
      }
    };

    if (periodicTaskId && !periodicTaskTabSelectedRef.current) {
      periodicTaskTabSelectedRef.current = true;
      if (!hasPersistedTabCheck()) {
        handleTopTabChange('periodic-task');
      }
    }
  }, [periodicTaskId, handleTopTabChange, workspaceId]);

  const handleBottomTabChange = useCallback(
    (tab: BottomPanelTab) => {
      setActiveBottomTab(tab);
      // Reset terminal tab state when switching away from terminal
      // to avoid stale state when TerminalPanel remounts
      if (tab !== 'terminal') {
        setTerminalTabState(null);
      }
    },
    [setActiveBottomTab]
  );

  useEffect(() => {
    if (!isLogsBottomTab(activeBottomTab)) {
      return;
    }
    setLastLogsTab(activeBottomTab);
  }, [activeBottomTab]);

  const handleLogsTabChange = useCallback(() => {
    handleBottomTabChange(lastLogsTab);
  }, [handleBottomTabChange, lastLogsTab]);

  const handleLogsSubTabChange = useCallback(
    (tab: LogsBottomTab) => {
      setLastLogsTab(tab);
      handleBottomTabChange(tab);
    },
    [handleBottomTabChange]
  );

  const isLogsActive = isLogsBottomTab(activeBottomTab);
  const activeLogsTab = isLogsBottomTab(activeBottomTab) ? activeBottomTab : lastLogsTab;

  const setupLogsStatus = getSetupLogsStatus(initStatus?.status);
  const devLogsStatus = getStreamingLogsStatus({
    connected: devLogs.connected,
    hasDisconnected: devLogs.hasDisconnected,
  });
  const postRunLogsStatus = getStreamingLogsStatus({
    connected: postRunLogs.connected,
    hasDisconnected: postRunLogs.hasDisconnected,
  });
  const logsGroupStatus = getLogsGroupStatus({
    setupLogsStatus,
    devLogsStatus,
    postRunLogsStatus,
  });

  const topPanel = (
    <TopPanelArea
      compact={isMobile}
      projectId={workspace?.projectId}
      workspaceId={workspaceId}
      activeTopTab={activeTopTab}
      onTopTabChange={handleTopTabChange}
      isTakingScreenshots={isTakingScreenshots}
      onTakeScreenshots={onTakeScreenshots ? handleTakeScreenshots : undefined}
      periodicTaskId={periodicTaskId}
      isParentWorkspace={isParentWorkspace}
      selectedSessionId={selectedSessionId}
      selectedSessionName={selectedSessionName}
      selectedSessionReady={selectedSessionReady}
      selectedSessionControlId={selectedSessionControlId}
      selectedSessionControlRuntimeId={selectedSessionControlRuntimeId}
      onOpenSubagent={onOpenSubagent}
    />
  );
  const bottomPanel = (
    <div className="flex flex-col h-full min-h-0">
      {/* Unified tab bar with terminal tabs inline */}
      <div
        className={cn(
          'flex items-center gap-0.5 p-1 bg-muted/50 min-w-0 overflow-x-auto',
          isMobile && 'min-h-11 [&_button]:min-h-11 [&_button]:min-w-11',
          !isLogsActive && 'border-b'
        )}
      >
        {!isMobile && (
          <TabButton
            label="Logs"
            icon={<StatusDot status={logsGroupStatus} />}
            isActive={isLogsActive}
            onSelect={handleLogsTabChange}
          />
        )}
        <TerminalControls
          activeBottomTab={activeBottomTab}
          terminalTabState={terminalTabState}
          onTabChange={handleBottomTabChange}
          onNewTab={() => terminalPanelRef.current?.createNewTerminal()}
        />
      </div>

      {isLogsActive && (
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-1 bg-muted/40 border-b min-w-0',
            isMobile && '[&_button]:min-h-11 [&_button]:min-w-11'
          )}
        >
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-medium whitespace-nowrap">
            Log source
          </span>
          <div className="flex items-center gap-0.5 min-w-0 rounded-md border border-border/70 bg-muted/70 p-0.5">
            <TabButton
              label="Setup"
              icon={<StatusDot status={setupLogsStatus} />}
              isActive={activeLogsTab === 'setup-logs'}
              onSelect={() => handleLogsSubTabChange('setup-logs')}
              className={getLogsSubTabButtonClass(activeLogsTab === 'setup-logs')}
            />
            <TabButton
              label="Dev"
              icon={<StatusDot status={devLogsStatus} />}
              isActive={activeLogsTab === 'dev-logs'}
              onSelect={() => handleLogsSubTabChange('dev-logs')}
              className={getLogsSubTabButtonClass(activeLogsTab === 'dev-logs')}
            />
            <TabButton
              label="Post-Run"
              icon={<StatusDot status={postRunLogsStatus} />}
              isActive={activeLogsTab === 'post-run-logs'}
              onSelect={() => handleLogsSubTabChange('post-run-logs')}
              className={getLogsSubTabButtonClass(activeLogsTab === 'post-run-logs')}
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeBottomTab === 'setup-logs' && (
          <SetupLogsPanel workspaceId={workspaceId} className="h-full" />
        )}
        {activeBottomTab === 'dev-logs' && (
          <DevLogsPanel
            output={devLogs.output}
            outputEndRef={devLogs.outputEndRef}
            className="h-full"
          />
        )}
        {activeBottomTab === 'post-run-logs' && (
          <DevLogsPanel
            output={postRunLogs.output}
            outputEndRef={postRunLogs.outputEndRef}
            className="h-full"
            emptyMessage="Waiting for post-run script output..."
          />
        )}
        {activeBottomTab === 'terminal' && (
          <TerminalPanel
            ref={terminalPanelRef}
            workspaceId={workspaceId}
            className="h-full"
            hideHeader
            onStateChange={handleTerminalStateChange}
          />
        )}
      </div>
    </div>
  );

  return (
    <RightPanelLayout
      workspaceId={workspaceId}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      periodicTaskId={periodicTaskId}
      onOpenLogs={handleLogsTabChange}
      className={className}
      topPanel={topPanel}
      bottomPanel={bottomPanel}
    />
  );
});

// =============================================================================
// Terminal Components
// =============================================================================

type StatusDotStatus = 'success' | 'pending' | 'error';

interface StatusDotProps {
  status: StatusDotStatus;
}

function StatusDot({ status }: StatusDotProps) {
  return (
    <span
      className={cn(
        'w-1.5 h-1.5 rounded-full',
        status === 'success' && 'bg-green-500',
        status === 'pending' && 'bg-yellow-500 animate-pulse',
        status === 'error' && 'bg-red-500'
      )}
    />
  );
}

function getSetupLogsStatus(status: string | undefined): StatusDotStatus {
  if (status === 'READY' || status === 'ARCHIVING' || status === 'ARCHIVED') {
    return 'success';
  }
  if (status === 'FAILED') {
    return 'error';
  }
  return 'pending';
}

function getStreamingLogsStatus({
  connected,
  hasDisconnected,
}: {
  connected: boolean;
  hasDisconnected: boolean;
}): StatusDotStatus {
  if (connected) {
    return 'success';
  }
  if (hasDisconnected) {
    return 'error';
  }
  return 'pending';
}

function getLogsGroupStatus({
  setupLogsStatus,
  devLogsStatus,
  postRunLogsStatus,
}: {
  setupLogsStatus: StatusDotStatus;
  devLogsStatus: StatusDotStatus;
  postRunLogsStatus: StatusDotStatus;
}): StatusDotStatus {
  if (setupLogsStatus === 'error') {
    return 'error';
  }
  if (setupLogsStatus === 'pending') {
    return 'pending';
  }
  if (devLogsStatus === 'error' || postRunLogsStatus === 'error') {
    return 'error';
  }
  if (devLogsStatus === 'pending' || postRunLogsStatus === 'pending') {
    return 'pending';
  }
  return 'success';
}

function TerminalControls({
  activeBottomTab,
  terminalTabState,
  onTabChange,
  onNewTab,
}: {
  activeBottomTab: BottomPanelTab;
  terminalTabState: TerminalTabState | null;
  onTabChange: (tab: BottomPanelTab) => void;
  onNewTab: () => void;
}) {
  return (
    <>
      {' '}
      {/* Show Terminal tab only if no terminals are open, otherwise show inline terminal tabs */}
      {activeBottomTab === 'terminal' && terminalTabState && terminalTabState.tabs.length > 0 ? (
        <TerminalTabsInline terminalTabState={terminalTabState} />
      ) : (
        <>
          <TabButton
            label="Terminal"
            icon={<TerminalIcon className="h-3.5 w-3.5" />}
            isActive={activeBottomTab === 'terminal'}
            onSelect={() => onTabChange('terminal')}
          />
          {/* Show + button when Terminal tab is active but no terminals exist */}
          {activeBottomTab === 'terminal' && (
            <NewTerminalButton onNewTab={terminalTabState?.onNewTab ?? onNewTab} />
          )}
        </>
      )}
    </>
  );
}

interface NewTerminalButtonProps {
  onNewTab: () => void;
}

function NewTerminalButton({ onNewTab }: NewTerminalButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNewTab}
            aria-label="New terminal"
            className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <PlusIcon className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>New terminal</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface TerminalTabsInlineProps {
  terminalTabState: TerminalTabState;
}

function TerminalTabsInline({ terminalTabState }: TerminalTabsInlineProps) {
  const { tabs, activeTabId, onSelectTab, onCloseTab, onNewTab } = terminalTabState;

  return (
    <TerminalTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      onSelectTab={onSelectTab}
      onCloseTab={onCloseTab}
      onNewTab={onNewTab}
      className="min-w-0 flex-1"
      renderNewButton={(handleNewTab) => <NewTerminalButton onNewTab={handleNewTab} />}
    />
  );
}

function getLogsSubTabButtonClass(isActive: boolean): string {
  return cn(
    'text-xs px-2 py-0.5 h-6 border-transparent',
    !isActive && 'text-muted-foreground/90 hover:text-foreground'
  );
}
