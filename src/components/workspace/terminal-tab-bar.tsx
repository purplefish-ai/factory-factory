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
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors group',
            activeTabId === tab.id
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
          )}
          onClick={() => onSelectTab(tab.id)}
        >
          <Terminal className="h-3 w-3" />
          <span>{tab.label}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            className={cn(
              'ml-1 p-0.5 rounded hover:bg-zinc-700 transition-colors',
              'opacity-0 group-hover:opacity-100',
              activeTabId === tab.id && 'opacity-100'
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </button>
      ))}

      <Button
        variant="ghost"
        size="icon"
        onClick={onNewTab}
        className="h-6 w-6"
        title="New terminal"
      >
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );
}
