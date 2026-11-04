import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { DotsThreeVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsThreeVertical';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Actions for the selected chat, pinned to the right of the chat tab bar.
 * Restart lives here rather than as an always-visible button: it is a recovery
 * action, needed when an agent is stuck, not on every turn.
 */
export function ChatActionsMenu({
  chatLabel,
  onRestartSession,
  disabled = false,
}: {
  /** The selected chat's tab label; null when no chat is selected. */
  chatLabel: string | null;
  onRestartSession: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Chat actions">
              <DotsThreeVerticalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Chat actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="truncate">
          {chatLabel ?? 'No chat selected'}
        </DropdownMenuLabel>
        <DropdownMenuItem
          disabled={disabled || chatLabel === null}
          onSelect={onRestartSession}
          className="items-start"
        >
          <ArrowsClockwiseIcon className="mt-0.5 h-4 w-4" />
          <span className="flex flex-col">
            <span>Restart agent</span>
            <span className="text-xs text-muted-foreground">
              Stop and restart the agent, resuming from where it left off
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
