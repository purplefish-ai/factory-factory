import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { ReactNode } from 'react';
import { useTablistFocus } from '@/client/hooks/use-tablist-focus';
import { Button } from '@/components/ui/button';
import { TabButton, TabList } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  onCloseTab?: (id: string) => void;
  /** Shows the "New terminal" button. */
  onNewTab?: () => void;
  /** Tabs rendered before the terminals in the same tablist, e.g. the panel's Logs tab. */
  leadingTabs?: ReactNode;
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
  leadingTabs,
  className,
}: TerminalTabBarProps) {
  const tabBarRef = useTablistFocus();
  const hasActiveTab = tabs.some((tab) => tab.id === activeTabId);
  return (
    <div ref={tabBarRef} className={cn('flex min-w-0 items-center gap-1', className)}>
      <TabList
        aria-label={leadingTabs ? 'Logs and terminals' : 'Terminals'}
        className="min-w-0 flex-1 gap-0.5"
      >
        {leadingTabs}
        {/* Leading tabs stay put while the terminals scroll. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map((tab, index) => (
            <TabButton
              key={tab.id}
              size="sm"
              icon={<TerminalIcon className="h-3 w-3 shrink-0" />}
              label={tab.label}
              isActive={tab.id === activeTabId}
              tabStop={tab.id === activeTabId || (!(leadingTabs || hasActiveTab) && index === 0)}
              onSelect={() => onSelectTab(tab.id)}
              onClose={onCloseTab ? () => onCloseTab(tab.id) : undefined}
            />
          ))}
        </div>
      </TabList>

      {onNewTab && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={onNewTab} aria-label="New terminal">
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New terminal</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
