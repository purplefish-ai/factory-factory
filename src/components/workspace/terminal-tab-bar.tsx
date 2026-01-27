'use client';

import { Plus, Terminal, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface TerminalTab {
  id: string;
  label: string;
}

interface TerminalTabBarProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function TerminalTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  className,
}: TerminalTabBarProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* Scrollable tabs container */}
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
                'mr-1 p-0.5 rounded hover:bg-zinc-700 transition-colors',
                'opacity-0 group-hover:opacity-100',
                activeTabId === tab.id && 'opacity-100'
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={onNewTab}
        className="h-6 w-6 flex-shrink-0"
        title="New terminal"
      >
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );
}
