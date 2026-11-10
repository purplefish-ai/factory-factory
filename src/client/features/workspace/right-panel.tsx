import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { SectionLabel } from '@/client/components/section-label';
import { StatusDot } from '@/client/components/status-indicators';
import { useWorkspaceUnreadCounts } from '@/client/features/inbox';
import type { SubagentSelection } from '@/client/features/subagents';
import { useWorkspaceDetailQuery } from '@/client/hooks/use-workspace-detail-query';
import { useWorkspaceDrawer } from '@/client/hooks/use-workspace-drawer';
import { readStorageItem } from '@/client/lib/browser-storage';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import type { StatusTone } from '@/client/lib/status-tones';
import { trpc } from '@/client/lib/trpc';
import { TabButton, TabList } from '@/components/ui/tab-button';
import { cn } from '@/lib/utils';
import { DevLogsPanel } from './dev-logs-panel';
import { RightPanelLayout } from './right-panel-layout';
import { STORAGE_KEY_TOP_TAB_PREFIX } from './right-panel-state';
import { TopPanelArea } from './right-panel-tools';
import { SetupLogsPanel } from './setup-logs-panel';
import { TerminalPanel, type TerminalTabState } from './terminal-panel';
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

const LOG_SOURCES: { tab: LogsBottomTab; label: string }[] = [
  { tab: 'setup-logs', label: 'Setup' },
  { tab: 'dev-logs', label: 'Dev' },
  { tab: 'post-run-logs', label: 'Post-Run' },
];

/** A log source's status dot: running (pulsing), connected or failed. */
type LogStatus = Extract<StatusTone, 'success' | 'working' | 'danger'>;

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
  const {
    mobilePanel,
    activeBottomTab,
    setActiveBottomTab,
    activeTopTab,
    setActiveTopTab: handleTopTabChange,
  } = useWorkspacePanel();
  const isMobile = useWorkspaceDrawer();

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
  const unreadCounts = useWorkspaceUnreadCounts(workspace?.projectId);
  const unreadCount = unreadCounts.data?.[workspaceId];
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
          : POLL_INTERVAL_MS.progress;
      },
    }
  );

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

  // Auto-select the periodic-task tab on first load, but only when the user
  // has no persisted tab preference for this workspace. WorkspacePanelProvider
  // remounts this panel for each workspace.
  const periodicTaskTabSelectedRef = useRef(false);
  useEffect(() => {
    if (periodicTaskId && !periodicTaskTabSelectedRef.current) {
      periodicTaskTabSelectedRef.current = true;
      if (readStorageItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`) === null) {
        handleTopTabChange('periodic-task');
      }
    }
  }, [periodicTaskId, handleTopTabChange, workspaceId]);

  const handleBottomTabChange = useCallback(
    (tab: BottomPanelTab) => {
      setActiveBottomTab(tab);
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
  const logStatuses: Record<LogsBottomTab, LogStatus> = {
    'setup-logs': setupLogsStatus,
    'dev-logs': devLogsStatus,
    'post-run-logs': postRunLogsStatus,
  };

  const topPanel = (
    <TopPanelArea
      compact={isMobile}
      unreadCount={unreadCount}
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
          'flex items-center gap-0.5 p-1 bg-shell min-w-0 overflow-x-auto',
          isMobile && 'min-h-9 [&_button]:min-h-9 [&_button]:min-w-9',
          !isLogsActive && 'border-b'
        )}
      >
        <TerminalControls
          activeBottomTab={activeBottomTab}
          terminalTabState={terminalTabState}
          onTabChange={handleBottomTabChange}
          leadingTabs={
            !isMobile && (
              <TabButton
                label="Logs"
                icon={<StatusDot tone={logsGroupStatus} size="xs" />}
                isActive={isLogsActive}
                onSelect={handleLogsTabChange}
              />
            )
          }
        />
      </div>

      {isLogsActive && (
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-1 bg-shell border-b min-w-0',
            isMobile && '[&_button]:min-h-9 [&_button]:min-w-9'
          )}
        >
          <SectionLabel className="whitespace-nowrap">Log source</SectionLabel>
          <TabList
            aria-label="Log source"
            className="gap-0.5 min-w-0 rounded-md border border-border/70 bg-muted/70 p-0.5"
          >
            {LOG_SOURCES.map(({ tab, label }) => (
              <TabButton
                key={tab}
                size="sm"
                label={label}
                icon={<StatusDot tone={logStatuses[tab]} size="xs" />}
                isActive={activeLogsTab === tab}
                onSelect={() => handleLogsSubTabChange(tab)}
                className="border-transparent"
              />
            ))}
          </TabList>
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
            emptyMessage="Waiting for post-run script output…"
          />
        )}
        <div hidden={activeBottomTab !== 'terminal'} className="h-full">
          <TerminalPanel
            key={workspaceId}
            isVisible={activeBottomTab === 'terminal' && (!isMobile || mobilePanel === 'bottom')}
            autoCreateWhenEmpty
            workspaceId={workspaceId}
            className="h-full"
            hideHeader
            onStateChange={handleTerminalStateChange}
          />
        </div>
      </div>
    </div>
  );

  return (
    <RightPanelLayout
      workspaceId={workspaceId}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      unreadCount={unreadCount}
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

function getSetupLogsStatus(status: string | undefined): LogStatus {
  if (status === 'READY' || status === 'ARCHIVING' || status === 'ARCHIVED') {
    return 'success';
  }
  if (status === 'FAILED') {
    return 'danger';
  }
  return 'working';
}

function getStreamingLogsStatus({
  connected,
  hasDisconnected,
}: {
  connected: boolean;
  hasDisconnected: boolean;
}): LogStatus {
  if (connected) {
    return 'success';
  }
  if (hasDisconnected) {
    return 'danger';
  }
  return 'working';
}

function getLogsGroupStatus({
  setupLogsStatus,
  devLogsStatus,
  postRunLogsStatus,
}: {
  setupLogsStatus: LogStatus;
  devLogsStatus: LogStatus;
  postRunLogsStatus: LogStatus;
}): LogStatus {
  if (setupLogsStatus === 'danger') {
    return 'danger';
  }
  if (setupLogsStatus === 'working') {
    return 'working';
  }
  if (devLogsStatus === 'danger' || postRunLogsStatus === 'danger') {
    return 'danger';
  }
  if (devLogsStatus === 'working' || postRunLogsStatus === 'working') {
    return 'working';
  }
  return 'success';
}

export function TerminalControls({
  activeBottomTab,
  terminalTabState,
  onTabChange,
  leadingTabs,
}: {
  activeBottomTab: BottomPanelTab;
  terminalTabState: TerminalTabState | null;
  onTabChange: (tab: BottomPanelTab) => void;
  /** Panel tabs before the terminals, in the same tablist (the desktop Logs tab). */
  leadingTabs?: ReactNode;
}) {
  const hasTabs = terminalTabState !== null && terminalTabState.tabs.length > 0;
  const openTerminal = () => onTabChange('terminal');
  return (
    <TerminalTabBar
      tabs={hasTabs ? terminalTabState.tabs : [{ id: 'empty', label: 'Terminal' }]}
      activeTabId={
        activeBottomTab === 'terminal' ? (hasTabs ? terminalTabState.activeTabId : 'empty') : null
      }
      onSelectTab={(id) => {
        openTerminal();
        if (hasTabs) {
          terminalTabState.onSelectTab(id);
        }
      }}
      onCloseTab={hasTabs ? terminalTabState.onCloseTab : undefined}
      onNewTab={() => {
        openTerminal();
        // Opening an empty panel creates its first terminal automatically.
        if (hasTabs) {
          terminalTabState.onNewTab();
        }
      }}
      leadingTabs={leadingTabs}
      className="min-w-0 flex-1"
    />
  );
}
