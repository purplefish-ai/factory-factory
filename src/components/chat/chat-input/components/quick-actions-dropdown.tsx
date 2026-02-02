import { Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { QUICK_ACTIONS } from '../constants';

interface QuickActionsDropdownProps {
  onAction: (message: string) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcut?: string;
  showShortcut?: boolean;
}

/**
 * Quick actions dropdown for sending predefined messages.
 */
export function QuickActionsDropdown({
  onAction,
  disabled,
  open,
  onOpenChange,
  shortcut,
  showShortcut = false,
}: QuickActionsDropdownProps) {
  const shortcutText = showShortcut && shortcut ? ` (${shortcut})` : '';
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-6 w-6 p-0"
                aria-label="Quick actions"
              >
                <Zap className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Quick actions{shortcutText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
      <DropdownMenuContent align="start" className="w-56">
        {QUICK_ACTIONS.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onClick={() => onAction(action.message)}
            className="gap-2"
          >
            <action.icon className="h-4 w-4" />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
