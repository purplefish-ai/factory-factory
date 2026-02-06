import {
  FileQuestion,
  Files,
  GitCompare,
  History,
  ListTodo,
  Plus,
  Terminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/components/chat';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { DevLogsPanel } from './dev-logs-panel';
import { DiffVsMainPanel } from './diff-vs-main-panel';
import { FileBrowserPanel } from './file-browser-panel';
import { RatchetLogPanel } from './ratchet-log-panel';
import { TerminalPanel, type TerminalPanelRef, type TerminalTabState } from './terminal-panel';
import { TodoPanelContainer } from './todo-panel-container';
import { UnstagedChangesPanel } from './unstaged-changes-panel';
import { useDevLogs } from './use-dev-logs';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';
const STORAGE_KEY_BOTTOM_TAB_PREFIX = 'workspace-right-panel-bottom-tab-';

// =============================================================================
// Types
// =============================================================================

type TopPanelTab = 'unstaged' | 'diff-vs-main' | 'files' | 'tasks';
type BottomPanelTab = 'terminal' | 'dev-logs' | 'ratchet-log';

// =============================================================================
// Main Component
// =============================================================================

interface RightPanelProps {
  workspaceId: string;
  className?: string;
  messages?: ChatMessage[];
}

export function RightPanel({ workspaceId, className, messages = [] }: RightPanelProps) {
  // Track which workspaceId has been loaded to handle workspace changes
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const [activeTopTab, setActiveTopTab] = useState<TopPanelTab>('unstaged');
  const [activeBottomTab, setActiveBottomTab] = useState<BottomPanelTab>('terminal');
  const terminalPanelRef = useRef<TerminalPanelRef>(null);

  // Single shared dev logs connection for both tab indicator and panel content
  const devLogs = useDevLogs(workspaceId);

  // Terminal tab state lifted up from TerminalPanel for inline rendering
  const [terminalTabState, setTerminalTabState] = useState<TerminalTabState | null>(null);

  const handleTerminalStateChange = useCallback((state: TerminalTabState) => {
    setTerminalTabState(state);
  }, []);

  // Load persisted tabs from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

    // Reset terminal tab state when workspace changes
    setTerminalTabState(null);

    try {
      const storedTop = localStorage.getItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`);
      if (
        storedTop === 'unstaged' ||
        storedTop === 'diff-vs-main' ||
        storedTop === 'files' ||
        storedTop === 'tasks'
      ) {
        setActiveTopTab(storedTop);
      }

      const storedBottom = localStorage.getItem(`${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`);
      if (
        storedBottom === 'terminal' ||
        storedBottom === 'dev-logs' ||
        storedBottom === 'ratchet-log'
      ) {
        setActiveBottomTab(storedBottom);
      }
    } catch {
      // Ignore storage errors
    }
  }, [workspaceId]);

  // Persist tab selection to localStorage
  const handleTabChange = (tab: TopPanelTab) => {
    setActiveTopTab(tab);
    try {
      localStorage.setItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`, tab);
    } catch {
      // Ignore storage errors
    }
  };

  const handleBottomTabChange = (tab: BottomPanelTab) => {
    setActiveBottomTab(tab);
    // Reset terminal tab state when switching away from terminal
    // to avoid stale state when TerminalPanel remounts
    if (tab !== 'terminal') {
      setTerminalTabState(null);
    }
    try {
      localStorage.setItem(`${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`, tab);
    } catch {
      // Ignore storage errors
    }
  };

  return (
    <ResizablePanelGroup
      direction="vertical"
      className={cn('h-full', className)}
      autoSaveId="workspace-right-panel"
    >
      {/* Top Panel: Git Status / File Browser */}
      <ResizablePanel defaultSize="60%" minSize="20%">
        <div className="flex flex-col h-full min-h-0">
          {/* Tab bar */}
          <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b">
            <TabButton
              label="Unstaged"
              icon={<FileQuestion className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'unstaged'}
              onSelect={() => handleTabChange('unstaged')}
            />
            <TabButton
              label="Diff vs Main"
              icon={<GitCompare className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'diff-vs-main'}
              onSelect={() => handleTabChange('diff-vs-main')}
            />
            <TabButton
              label="Files"
              icon={<Files className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'files'}
              onSelect={() => handleTabChange('files')}
            />
            <TabButton
              label="Tasks"
              icon={<ListTodo className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'tasks'}
              onSelect={() => handleTabChange('tasks')}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {activeTopTab === 'unstaged' && <UnstagedChangesPanel workspaceId={workspaceId} />}
            {activeTopTab === 'diff-vs-main' && <DiffVsMainPanel workspaceId={workspaceId} />}
            {activeTopTab === 'files' && <FileBrowserPanel workspaceId={workspaceId} />}
            {activeTopTab === 'tasks' && <TodoPanelContainer messages={messages} />}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle direction="vertical" />

      {/* Bottom Panel: Terminal / Dev Logs */}
      <ResizablePanel defaultSize="40%" minSize="15%">
        <div className="flex flex-col h-full min-h-0">
          {/* Unified tab bar with terminal tabs inline */}
          <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b min-w-0">
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
            <TabButton
              label="Ratchet"
              icon={<History className="h-3.5 w-3.5" />}
              isActive={activeBottomTab === 'ratchet-log'}
              onSelect={() => handleBottomTabChange('ratchet-log')}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {activeBottomTab === 'terminal' && (
              <TerminalPanel
                ref={terminalPanelRef}
                workspaceId={workspaceId}
                className="h-full"
                hideHeader
                onStateChange={handleTerminalStateChange}
              />
            )}
            {activeBottomTab === 'dev-logs' && (
              <DevLogsPanel
                output={devLogs.output}
                outputEndRef={devLogs.outputEndRef}
                className="h-full"
              />
            )}
            {activeBottomTab === 'ratchet-log' && (
              <RatchetLogPanel workspaceId={workspaceId} className="h-full" />
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
    <>
      {/* Terminal tabs */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide flex-nowrap min-w-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'flex items-center rounded-md transition-colors group flex-shrink-0',
              activeTabId === tab.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
            )}
          >
            <button
              type="button"
              className="flex items-center gap-1 px-2 py-1 text-xs cursor-pointer whitespace-nowrap"
              onClick={() => onSelectTab(tab.id)}
            >
              <Terminal className="h-3 w-3 flex-shrink-0" />
              <span>{tab.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onCloseTab(tab.id)}
              className={cn(
                'mr-1 p-0.5 rounded hover:bg-zinc-600/50 transition-colors',
                'opacity-0 group-hover:opacity-100',
                activeTabId === tab.id && 'opacity-100'
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {/* New terminal button with tooltip */}
      <NewTerminalButton onNewTab={onNewTab} />
    </>
  );
}
