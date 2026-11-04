import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

type LaunchMode = 'STANDARD' | 'PERIODIC_TASK';
export function WorkspaceLaunchButton({
  mode,
  purpose,
  isCreating,
  isBusy,
  disabled,
  reason,
  onLaunch,
  onModeChange,
}: {
  mode: LaunchMode;
  purpose?: 'event-agent';
  isCreating: boolean;
  isBusy: boolean;
  disabled: boolean;
  reason?: string;
  onLaunch: () => void;
  onModeChange: (mode: LaunchMode) => void;
}) {
  return (
    <div className="flex min-w-0">
      <Button
        size="sm"
        className={cn(
          'h-7 min-w-0 shrink text-xs whitespace-nowrap',
          !purpose && 'rounded-r-none',
          mode !== 'STANDARD' && 'bg-primary/90'
        )}
        onClick={onLaunch}
        disabled={disabled}
        title={reason}
        aria-description={reason}
      >
        {isCreating ? <Spinner className="size-3" aria-hidden="true" /> : null}
        <span className="truncate">{mode === 'PERIODIC_TASK' ? 'Create agent' : 'Launch'}</span>
      </Button>
      {!purpose && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5"
              disabled={isBusy}
              aria-label="Choose launch mode"
            >
              <CaretDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem className="text-xs" onClick={() => onModeChange('STANDARD')}>
              Launch as Standard Workspace
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={() => onModeChange('PERIODIC_TASK')}>
              <RobotIcon className="mr-1.5 h-3 w-3" />
              Create agent
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
