import { Plus, Terminal, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface TerminalTab {
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
  renderNewButton?: (onNewTab: () => void) => ReactNode;
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
  renderNewButton,
  className,
}: TerminalTabBarProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-0.5 overflow-hidden', className)}>
      {/* Scrollable tabs container */}
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'group flex h-7 flex-shrink-0 items-center rounded-none transition-colors',
              activeTabId === tab.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
            )}
          >
            <button
              type="button"
              className="flex h-full cursor-pointer items-center gap-1 whitespace-nowrap px-2 text-xs"
              onClick={() => onSelectTab(tab.id)}
            >
              <Terminal className="h-3 w-3 flex-shrink-0" />
              <span>{tab.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onCloseTab(tab.id)}
              className={cn(
                'mr-1 rounded-none p-0.5 transition-colors hover:bg-zinc-600/50',
                'opacity-0 group-hover:opacity-100',
                activeTabId === tab.id && 'opacity-100'
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {showNewButton &&
        onNewTab &&
        (renderNewButton ? (
          renderNewButton(onNewTab)
        ) : (
          <button
            type="button"
            onClick={onNewTab}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            title="New terminal"
          >
            <Plus className="h-3 w-3" />
          </button>
        ))}
    </div>
  );
}
