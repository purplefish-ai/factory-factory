'use client';

import { Files, GitBranch } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { FileBrowserPanel } from './file-browser-panel';
import { GitSummaryPanel } from './git-summary-panel';
import { TerminalPanel } from './terminal-panel';

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

  return (
    <div className={cn('h-full flex flex-col', className)}>
      {/* Top Panel: Git Status / File Browser (60% height) */}
      <div className="flex-[6] flex flex-col min-h-0">
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

      {/* Bottom Panel: Terminal (40% height) */}
      <div className="flex-[4] min-h-0 border-t">
        <TerminalPanel workspaceId={workspaceId} className="h-full" />
      </div>
    </div>
  );
}
