'use client';

import { Files, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

import { FileBrowserPanel } from './file-browser-panel';
import { GitSummaryPanel } from './git-summary-panel';
import { TerminalPanel } from './terminal-panel';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';

// =============================================================================
// Types
// =============================================================================

type TopPanelTab = 'git' | 'files';

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
}

export function RightPanel({ workspaceId, className }: RightPanelProps) {
  // Track which workspaceId has been loaded to handle workspace changes
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const [activeTopTab, setActiveTopTab] = useState<TopPanelTab>('git');

  // Load persisted tab from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }
    loadedForWorkspaceRef.current = workspaceId;

    try {
      const stored = localStorage.getItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`);
      if (stored === 'git' || stored === 'files') {
        setActiveTopTab(stored);
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

  return (
    <ResizablePanelGroup
      direction="vertical"
      className={cn('h-full', className)}
      autoSaveId="workspace-right-panel"
    >
      {/* Top Panel: Git Status / File Browser */}
      <ResizablePanel defaultSize={60} minSize={20}>
        <div className="flex flex-col h-full min-h-0">
          {/* Tab bar */}
          <div className="flex items-center gap-0.5 p-1 bg-muted/50 border-b">
            <PanelTab
              label="Git"
              icon={<GitBranch className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'git'}
              onClick={() => handleTabChange('git')}
            />
            <PanelTab
              label="Files"
              icon={<Files className="h-3.5 w-3.5" />}
              isActive={activeTopTab === 'files'}
              onClick={() => handleTabChange('files')}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {activeTopTab === 'git' && <GitSummaryPanel workspaceId={workspaceId} />}
            {activeTopTab === 'files' && <FileBrowserPanel workspaceId={workspaceId} />}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* Bottom Panel: Terminal */}
      <ResizablePanel defaultSize={40} minSize={15}>
        <TerminalPanel workspaceId={workspaceId} className="h-full" />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
