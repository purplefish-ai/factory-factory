import { Plus, Terminal, X } from 'lucide-react';

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
  onNewTab?: () => void;
  showNewButton?: boolean;
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
  showNewButton = true,
  className,
}: TerminalTabBarProps) {
  return (
    <div className={cn('flex items-center gap-1 min-w-0 overflow-hidden', className)}>
      {/* Scrollable tabs container */}
      <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-hide flex-nowrap min-w-0">
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

      {showNewButton && onNewTab && (
        <button
          type="button"
          onClick={onNewTab}
          className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          title="New terminal"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
