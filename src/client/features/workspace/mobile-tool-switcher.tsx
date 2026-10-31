import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspacePanel } from './workspace-panel-context';

const overflowTools = [
  { value: 'agents', label: 'Sessions' },
  { value: 'screenshots', label: 'Screenshots' },
  { value: 'periodic-task', label: 'Agent' },
  { value: 'logs', label: 'Logs' },
] as const;

const tabClassName =
  'h-11 flex-none rounded-none px-2.5 text-xs group-data-[orientation=horizontal]/tabs:after:bottom-0';

export function MobileToolSwitcher({
  periodicTaskId,
  onOpenLogs,
  children,
}: {
  periodicTaskId: string | null;
  onOpenLogs: () => void;
  children: ReactNode;
}) {
  const { mobilePanel, activeTopTab, activeBottomTab, setActiveTopTab, setActiveBottomTab } =
    useWorkspacePanel();
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
      <nav aria-label="Workspace tools" className="flex h-11 shrink-0 items-center border-b">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList variant="line" aria-label="Workspace tools" className="h-11 gap-0 p-0">
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
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 rounded-none"
              aria-label="More tools"
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={activeTool} onValueChange={selectTool}>
              {overflowTools
                .filter((tool) => tool.value !== 'periodic-task' || periodicTaskId)
                .map((tool) => (
                  <DropdownMenuRadioItem key={tool.value} value={tool.value} className="min-h-11">
                    {tool.label}
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
