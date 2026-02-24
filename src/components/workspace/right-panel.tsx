import { Camera, FileQuestion, Files, ListTodo, Plus, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import type { ChatMessage } from '@/components/chat';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { CombinedChangesPanel } from './combined-changes-panel';
import { DevLogsPanel } from './dev-logs-panel';
import { FileBrowserPanel } from './file-browser-panel';
import { ScreenshotsPanel } from './screenshots-panel';
import { SetupLogsPanel } from './setup-logs-panel';
import { TerminalPanel, type TerminalPanelRef, type TerminalTabState } from './terminal-panel';
import { TerminalTabBar } from './terminal-tab-bar';
import { TodoPanelContainer } from './todo-panel-container';
import { useDevLogs } from './use-dev-logs';
import { usePostRunLogs } from './use-post-run-logs';
import { type BottomPanelTab, useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';

// =============================================================================
// Types
// =============================================================================

type TopPanelTab = 'changes' | 'files' | 'tasks' | 'screenshots';
type LogsBottomTab = Exclude<BottomPanelTab, 'terminal'>;

interface PersistedTopPanelState {
  topTab: TopPanelTab;
}

function isLogsBottomTab(tab: BottomPanelTab): tab is LogsBottomTab {
  return tab === 'setup-logs' || tab === 'dev-logs' || tab === 'post-run-logs';
}

function parseStoredTopTab(value: string | null): TopPanelTab | null {
  if (value === 'changes' || value === 'files' || value === 'tasks' || value === 'screenshots') {
    return value;
  }
  // Legacy migration: old values were direct changes sub-views.
  if (value === 'unstaged' || value === 'diff-vs-main') {
    return 'changes';
  }
  return null;
}

function loadPersistedTopPanelState(workspaceId: string): PersistedTopPanelState {
  const defaultState: PersistedTopPanelState = { topTab: 'changes' };

  if (typeof window === 'undefined') {
    return defaultState;
  }

  try {
    const storedTop = localStorage.getItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`);
    const topTab = parseStoredTopTab(storedTop);
    if (topTab) {
      // Migrate legacy top-level tab values to the new "changes" tab key.
      if (storedTop === 'unstaged' || storedTop === 'diff-vs-main') {
        localStorage.setItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`, 'changes');
        return { topTab: 'changes' };
      }
      return { topTab };
    }
  } catch {
    // Ignore storage errors
  }

  return defaultState;
}

// =============================================================================
// Main Component
// =============================================================================

interface RightPanelProps {
  workspaceId: string;
  className?: string;
  messages?: ChatMessage[];
  onTakeScreenshots?: () => void;
}

interface TopPanelAreaProps {
  workspaceId: string;
  messages: ChatMessage[];
  activeTopTab: TopPanelTab;
  onTopTabChange: (tab: TopPanelTab) => void;
  onTakeScreenshots: () => void;
}

function TopPanelArea({
  workspaceId,
  messages,
  activeTopTab,
  onTopTabChange,
  onTakeScreenshots,
}: TopPanelAreaProps) {
  const showChanges = activeTopTab === 'changes';
  const showFiles = activeTopTab === 'files';
  const showTasks = activeTopTab === 'tasks';
  const showScreenshots = activeTopTab === 'screenshots';

  const screenshotsButtonClassName = cn(
    'h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md transition-colors',
    showScreenshots
      ? 'bg-background text-foreground shadow-sm border border-border'
      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border border-transparent'
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b">
        <TabButton
          label="Changes"
          icon={<FileQuestion className="h-3.5 w-3.5" />}
          isActive={showChanges}
          onSelect={() => onTopTabChange('changes')}
        />
        <TabButton
          label="Files"
          icon={<Files className="h-3.5 w-3.5" />}
          isActive={showFiles}
          onSelect={() => onTopTabChange('files')}
        />
        <TabButton
          label="Tasks"
          icon={<ListTodo className="h-3.5 w-3.5" />}
          isActive={showTasks}
          onSelect={() => onTopTabChange('tasks')}
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
                <Camera className="h-3.5 w-3.5" />
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
        {showTasks && <TodoPanelContainer messages={messages} />}
        {showScreenshots && (
          <ScreenshotsPanel workspaceId={workspaceId} onTakeScreenshots={onTakeScreenshots} />
        )}
      </div>
    </div>
  );
}

export function RightPanel({
  workspaceId,
  className,
  messages = [],
  onTakeScreenshots,
}: RightPanelProps) {
  // Track which workspaceId has been loaded to handle workspace changes
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const [activeTopTab, setActiveTopTab] = useState<TopPanelTab>('changes');
  const { activeBottomTab, setActiveBottomTab } = useWorkspacePanel();
  const terminalPanelRef = useRef<TerminalPanelRef>(null);

  // Single shared dev logs connection for both tab indicator and panel content
  const devLogs = useDevLogs(workspaceId);
  const postRunLogs = usePostRunLogs(workspaceId);

  // Terminal tab state lifted up from TerminalPanel for inline rendering
  const [terminalTabState, setTerminalTabState] = useState<TerminalTabState | null>(null);

  // Track last selected logs subtab for Logs tab navigation
  const [lastLogsTab, setLastLogsTab] = useState<LogsBottomTab>('setup-logs');

  const handleTerminalStateChange = useCallback((state: TerminalTabState) => {
    setTerminalTabState(state);
  }, []);

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

  // Load persisted tabs from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

    // Reset terminal tab state when workspace changes
    setTerminalTabState(null);

    // Reset logs subtab selection to default when workspace changes
    setLastLogsTab('setup-logs');

    const persisted = loadPersistedTopPanelState(workspaceId);
    setActiveTopTab(persisted.topTab);
  }, [workspaceId]);

  // Persist top-level tab selection to localStorage
  const handleTopTabChange = useCallback(
    (tab: TopPanelTab) => {
      setActiveTopTab(tab);
      try {
        localStorage.setItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`, tab);
      } catch {
        // Ignore storage errors
      }
    },
    [workspaceId]
  );

  const handleTakeScreenshots = useCallback(() => {
    handleTopTabChange('screenshots');
    onTakeScreenshots?.();
  }, [handleTopTabChange, onTakeScreenshots]);

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

  return (
    <ResizablePanelGroup
      direction="vertical"
      className={cn('h-full', className)}
      autoSaveId="workspace-right-panel"
    >
      {/* Top Panel: Git Status / File Browser */}
      <ResizablePanel defaultSize="60%" minSize="20%">
        <TopPanelArea
          workspaceId={workspaceId}
          messages={messages}
          activeTopTab={activeTopTab}
          onTopTabChange={handleTopTabChange}
          onTakeScreenshots={handleTakeScreenshots}
        />
      </ResizablePanel>

      <ResizableHandle direction="vertical" />

      {/* Bottom Panel: Terminal / Logs */}
      <ResizablePanel defaultSize="40%" minSize="15%">
        <div className="flex flex-col h-full min-h-0">
          {/* Unified tab bar with terminal tabs inline */}
          <div
            className={cn(
              'flex items-center gap-0.5 p-1 bg-muted/50 min-w-0',
              !isLogsActive && 'border-b'
            )}
          >
            <TabButton
              label="Logs"
              icon={<StatusDot status={logsGroupStatus} />}
              isActive={isLogsActive}
              onSelect={handleLogsTabChange}
            />
            {/* Show Terminal tab only if no terminals are open, otherwise show inline terminal tabs */}
            {activeBottomTab === 'terminal' &&
            terminalTabState &&
            terminalTabState.tabs.length > 0 ? (
              <TerminalTabsInline terminalTabState={terminalTabState} />
            ) : (
              <>
                <TabButton
                  label="Terminal"
                  icon={<Terminal className="h-3.5 w-3.5" />}
                  isActive={activeBottomTab === 'terminal'}
                  onSelect={() => handleBottomTabChange('terminal')}
                />
                {/* Show + button when Terminal tab is active but no terminals exist */}
                {activeBottomTab === 'terminal' && (
                  <NewTerminalButton
                    onNewTab={
                      terminalTabState?.onNewTab ??
                      (() => terminalPanelRef.current?.createNewTerminal())
                    }
                  />
                )}
              </>
            )}
          </div>

          {isLogsActive && (
            <div className="flex items-center gap-2 px-2 py-1 bg-muted/40 border-b min-w-0">
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
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

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
            className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
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
