'use client';

import { FileCode, FileDiff, MessageSquare, X } from 'lucide-react';
import { useCallback } from 'react';

import { cn } from '@/lib/utils';

import type { MainViewTab } from './workspace-panel-context';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Helper Functions
// =============================================================================

function getTabIcon(type: MainViewTab['type']) {
  switch (type) {
    case 'chat':
      return MessageSquare;
    case 'file':
      return FileCode;
    case 'diff':
      return FileDiff;
  }
}

// =============================================================================
// Sub-Components
// =============================================================================

interface TabItemProps {
  tab: MainViewTab;
  isActive: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function TabItem({ tab, isActive, onSelect, onClose }: TabItemProps) {
  const Icon = getTabIcon(tab.type);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose?.();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    },
    [onSelect]
  );

  return (
    <div
      role="tab"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      aria-selected={isActive}
      className={cn(
        'group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium cursor-pointer',
        'rounded-md transition-all whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isActive
          ? 'bg-background text-foreground shadow-md border border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />

      <span className="truncate max-w-[120px]">{tab.label}</span>

      {/* Close button - only for non-chat tabs, visible on hover */}
      {onClose && (
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            'ml-1 rounded p-0.5 opacity-0 transition-opacity',
            'hover:bg-muted-foreground/20 focus-visible:opacity-100',
            'group-hover:opacity-100'
          )}
          aria-label={`Close ${tab.label}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

interface MainViewTabBarProps {
  className?: string;
}

export function MainViewTabBar({ className }: MainViewTabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab } = useWorkspacePanel();

  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-1 bg-muted rounded-lg p-1 overflow-x-auto', className)}
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {tabs.map((tab) => {
        const isChat = tab.type === 'chat';
        return (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSelect={() => selectTab(tab.id)}
            onClose={isChat ? undefined : () => closeTab(tab.id)}
          />
        );
      })}
    </div>
  );
}
