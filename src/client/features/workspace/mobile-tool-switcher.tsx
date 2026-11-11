import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { type ReactNode, useEffect, useRef } from 'react';
import { UnreadMailBadge } from '@/client/features/inbox';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TopPanelTab } from './right-panel-state';
import { useWorkspacePanel } from './workspace-panel-context';

const overflowTools = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'agents', label: 'Subagents' },
  { value: 'screenshots', label: 'Screenshots' },
  { value: 'periodic-task', label: 'Runs' },
  { value: 'logs', label: 'Logs' },
] as const;

const tabClassName =
  'h-9 flex-none rounded-none px-2.5 text-xs group-data-[orientation=horizontal]/tabs:after:bottom-0';

export function MobileToolSwitcher({
  activeTopTab,
  periodicTaskId,
  unreadCount,
  onOpenLogs,
  children,
}: {
  /** The top tab RightPanel shows (resolveTopTab). */
  activeTopTab: TopPanelTab;
  periodicTaskId: string | null;
  unreadCount?: number;
  onOpenLogs: () => void;
  children: ReactNode;
}) {
  const { mobilePanel, activeBottomTab, setActiveTopTab, setActiveBottomTab } = useWorkspacePanel();
  const activeTool =
    mobilePanel === 'top' ? activeTopTab : activeBottomTab === 'terminal' ? 'terminal' : 'logs';
  const activeOverflowTool = overflowTools.find((tool) => tool.value === activeTool);
  const activeOverflowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activeOverflowTool) {
      activeOverflowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeOverflowTool]);

  function selectTool(value: string) {
    switch (value) {
      case 'changes':
      case 'files':
      case 'agents':
      case 'inbox':
      case 'screenshots':
      case 'periodic-task':
        setActiveTopTab(value);
        break;
      case 'terminal':
        setActiveBottomTab('terminal');
        break;
      case 'logs':
        onOpenLogs();
        break;
    }
  }

  return (
    <Tabs value={activeTool} onValueChange={selectTool} className="h-full min-h-0 gap-0">
      <nav
        aria-label="Workspace tools"
        className="flex h-9 shrink-0 items-center border-b bg-shell"
      >
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList variant="line" aria-label="Workspace tools" className="h-9 gap-0 p-0">
            <TabsTrigger value="changes" className={tabClassName}>
              Changes
            </TabsTrigger>
            <TabsTrigger value="files" className={tabClassName}>
              Files
            </TabsTrigger>
            <TabsTrigger value="terminal" className={tabClassName}>
              Terminal
            </TabsTrigger>
            {activeOverflowTool && (
              <TabsTrigger
                ref={activeOverflowRef}
                value={activeOverflowTool.value}
                className={tabClassName}
              >
                {activeOverflowTool.label}
                {activeOverflowTool.value === 'inbox' && (
                  <UnreadMailBadge count={unreadCount} icon={false} />
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative rounded-none"
              aria-label={
                unreadCount && activeTool !== 'inbox'
                  ? `More tools, ${unreadCount} unread inbox ${unreadCount === 1 ? 'message' : 'messages'}`
                  : 'More tools'
              }
            >
              <DotsThreeIcon />
              {activeTool !== 'inbox' && (
                <UnreadMailBadge
                  count={unreadCount}
                  icon={false}
                  className="absolute right-0 top-0"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={activeTool} onValueChange={selectTool}>
              {overflowTools
                .filter((tool) => tool.value !== 'periodic-task' || periodicTaskId)
                .map((tool) => (
                  <DropdownMenuRadioItem key={tool.value} value={tool.value} className="min-h-9">
                    {tool.label}
                    {tool.value === 'inbox' && <UnreadMailBadge count={unreadCount} icon={false} />}
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
      {children}
    </Tabs>
  );
}
