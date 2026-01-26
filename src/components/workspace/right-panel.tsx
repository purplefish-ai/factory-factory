'use client';

import { Files, GitBranch } from 'lucide-react';
import { useCallback, useState } from 'react';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

import { FileBrowserPanel } from './file-browser-panel';
import { GitSummaryPanel } from './git-summary-panel';
import { TerminalPanel } from './terminal-panel';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_VERTICAL_SPLIT = 'workspace-right-panel-vertical-split';
const TOP_PANEL_ID = 'right-panel-top';
const BOTTOM_PANEL_ID = 'right-panel-bottom';

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
        'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
        isActive
          ? 'bg-background text-foreground shadow-sm border border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
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
  const [activeTopTab, setActiveTopTab] = useState<TopPanelTab>('git');

  // Handle resize layout persistence
  const handleLayoutChange = useCallback((layout: Record<string, number>) => {
    localStorage.setItem(STORAGE_KEY_VERTICAL_SPLIT, JSON.stringify(layout));
  }, []);

  // Load initial layout from localStorage
  const getDefaultLayout = useCallback((): Record<string, number> | undefined => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const stored = localStorage.getItem(STORAGE_KEY_VERTICAL_SPLIT);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, []);

  const defaultLayout = getDefaultLayout();

  return (
    <div className={cn('h-full flex flex-col', className)}>
      <ResizablePanelGroup
        orientation="vertical"
        onLayoutChange={handleLayoutChange}
        defaultLayout={defaultLayout}
        className="h-full"
      >
        {/* Top Panel: Git Status / File Browser */}
        <ResizablePanel id={TOP_PANEL_ID} defaultSize={60} minSize={20}>
          <div className="h-full flex flex-col">
            {/* Tab bar */}
            <div className="flex items-center gap-1 p-2 bg-muted/50 border-b">
              <PanelTab
                label="Git"
                icon={<GitBranch className="h-4 w-4" />}
                isActive={activeTopTab === 'git'}
                onClick={() => setActiveTopTab('git')}
              />
              <PanelTab
                label="Files"
                icon={<Files className="h-4 w-4" />}
                isActive={activeTopTab === 'files'}
                onClick={() => setActiveTopTab('files')}
              />
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
              {activeTopTab === 'git' && <GitSummaryPanel workspaceId={workspaceId} />}
              {activeTopTab === 'files' && <FileBrowserPanel workspaceId={workspaceId} />}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel: Terminal */}
        <ResizablePanel id={BOTTOM_PANEL_ID} defaultSize={40} minSize={15}>
          <TerminalPanel workspaceId={workspaceId} className="h-full" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
