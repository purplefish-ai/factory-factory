'use client';

import { FileQuestion, Files, GitCompare, ListTodo, ScrollText, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/components/chat';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

import { DevLogsPanel } from './dev-logs-panel';
import { DiffVsMainPanel } from './diff-vs-main-panel';
import { FileBrowserPanel } from './file-browser-panel';
import { TerminalPanel } from './terminal-panel';
import { TodoPanelContainer } from './todo-panel-container';
import { UnstagedChangesPanel } from './unstaged-changes-panel';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';
const STORAGE_KEY_BOTTOM_TAB_PREFIX = 'workspace-right-panel-bottom-tab-';

// =============================================================================
// Types
// =============================================================================

type TopPanelTab = 'unstaged' | 'diff-vs-main' | 'files' | 'tasks';
type BottomPanelTab = 'terminal' | 'dev-logs';

// =============================================================================
// Sub-Components
// =============================================================================

interface PanelTabProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

function PanelTab({ label, icon, isActive, onClick }: PanelTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-2 py-1 text-sm font-medium rounded-md transition-colors border',
        isActive
          ? 'bg-background text-foreground shadow-sm border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

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

  // Load persisted tabs from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

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
      if (storedBottom === 'terminal' || storedBottom === 'dev-logs') {
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
            <PanelTab
              label="Unstaged"
              icon={<FileQuestion className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'unstaged'}
              onClick={() => handleTabChange('unstaged')}
            />
            <PanelTab
              label="Diff vs Main"
              icon={<GitCompare className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'diff-vs-main'}
              onClick={() => handleTabChange('diff-vs-main')}
            />
            <PanelTab
              label="Files"
              icon={<Files className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'files'}
              onClick={() => handleTabChange('files')}
            />
            <PanelTab
              label="Tasks"
              icon={<ListTodo className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'tasks'}
              onClick={() => handleTabChange('tasks')}
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
          {/* Tab bar */}
          <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b">
            <PanelTab
              label="Terminal"
              icon={<Terminal className="h-3.5 w-3.5" />}
              isActive={activeBottomTab === 'terminal'}
              onClick={() => handleBottomTabChange('terminal')}
            />
            <PanelTab
              label="Dev Logs"
              icon={<ScrollText className="h-3.5 w-3.5" />}
              isActive={activeBottomTab === 'dev-logs'}
              onClick={() => handleBottomTabChange('dev-logs')}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {activeBottomTab === 'terminal' && (
              <TerminalPanel workspaceId={workspaceId} className="h-full" />
            )}
            {activeBottomTab === 'dev-logs' && (
              <DevLogsPanel workspaceId={workspaceId} className="h-full" />
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
