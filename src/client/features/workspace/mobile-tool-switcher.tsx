import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorkspacePanel } from './workspace-panel-context';

export function MobileToolSwitcher({ periodicTaskId }: { periodicTaskId: string | null }) {
  const { mobilePanel, activeTopTab, activeBottomTab, setActiveTopTab, setActiveBottomTab } =
    useWorkspacePanel();
  const changesActive = mobilePanel === 'top' && activeTopTab === 'changes';
  const terminalActive = mobilePanel === 'bottom' && activeBottomTab === 'terminal';
  const otherLabel =
    mobilePanel === 'bottom'
      ? 'Logs'
      : {
          changes: 'More tools',
          files: 'Files',
          screenshots: 'Screenshots',
          'periodic-task': 'Agent',
          agents: 'Sessions',
        }[activeTopTab];
  return (
    <nav
      aria-label="Workspace tools"
      className="flex shrink-0 items-center gap-1 border-b bg-muted/30 p-2"
    >
      <div className="flex min-w-0 flex-1 gap-1">
        <Button
          variant="ghost"
          aria-pressed={changesActive}
          onClick={() => setActiveTopTab('changes')}
          className={cn('min-h-11 flex-1 px-2', changesActive && 'bg-background shadow-sm')}
        >
          Changes
        </Button>
        <Button
          variant="ghost"
          aria-pressed={terminalActive}
          onClick={() => setActiveBottomTab('terminal')}
          className={cn('min-h-11 flex-1 px-2', terminalActive && 'bg-background shadow-sm')}
        >
          Terminal
        </Button>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              'min-h-11 max-w-28 gap-1 px-2',
              !(changesActive || terminalActive) && 'bg-background shadow-sm'
            )}
            aria-label={
              changesActive || terminalActive ? 'More tools' : `${otherLabel}, more tools`
            }
          >
            <span className="truncate">
              {changesActive || terminalActive ? 'More' : otherLabel}
            </span>
            <DotsThreeIcon className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" onSelect={() => setActiveTopTab('files')}>
            Files
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => setActiveTopTab('agents')}>
            Sessions
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => setActiveTopTab('screenshots')}>
            Screenshots
          </DropdownMenuItem>
          {periodicTaskId && (
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => setActiveTopTab('periodic-task')}
            >
              Agent
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="min-h-11" onSelect={() => setActiveBottomTab('setup-logs')}>
            Logs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
