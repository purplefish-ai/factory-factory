import { Camera, FileQuestion, Files, ListTodo, Play, Plus, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/components/chat';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/frontend/lib/trpc';
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
import { type BottomPanelTab, useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';

// =============================================================================
// Types
// =============================================================================

type TopPanelTab = 'changes' | 'files' | 'tasks' | 'screenshots';

interface PersistedTopPanelState {
  topTab: TopPanelTab;
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

  // Terminal tab state lifted up from TerminalPanel for inline rendering
  const [terminalTabState, setTerminalTabState] = useState<TerminalTabState | null>(null);

  const handleTerminalStateChange = useCallback((state: TerminalTabState) => {
    setTerminalTabState(state);
  }, []);

  // Auto-switch to Setup Logs during provisioning, back to terminal when done
  const { data: initStatus } = trpc.workspace.getInitStatus.useQuery(
    { id: workspaceId },
    {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === 'READY' || status === 'FAILED' || status === 'ARCHIVED' ? false : 1000;
      },
    }
  );
  const prevInitStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const status = initStatus?.status;
    const prev = prevInitStatusRef.current;
    prevInitStatusRef.current = status;

    // On first load or workspace change: if provisioning, switch to setup logs
    if (prev === undefined && (status === 'NEW' || status === 'PROVISIONING')) {
      setActiveBottomTab('setup-logs');
    }
  }, [initStatus?.status, setActiveBottomTab]);

  // Load persisted tabs from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

    // Reset terminal tab state when workspace changes
    setTerminalTabState(null);

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

      {/* Bottom Panel: Terminal / Dev Logs */}
      <ResizablePanel defaultSize="40%" minSize="15%">
        <div className="flex flex-col h-full min-h-0">
          {/* Unified tab bar with terminal tabs inline */}
          <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b min-w-0">
            <TabButton
              label="Setup Logs"
              icon={<Play className="h-3.5 w-3.5" />}
              isActive={activeBottomTab === 'setup-logs'}
              onSelect={() => handleBottomTabChange('setup-logs')}
            />
            <TabButton
              label="Dev Logs"
              icon={
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    devLogs.connected ? 'bg-green-500' : 'bg-red-500'
                  )}
                />
              }
              isActive={activeBottomTab === 'dev-logs'}
              onSelect={() => handleBottomTabChange('dev-logs')}
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
