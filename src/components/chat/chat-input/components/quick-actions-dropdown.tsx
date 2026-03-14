import {
  GitPullRequest,
  type LucideIcon,
  MessageSquareText,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import { QUICK_ACTIONS } from '@/components/chat/chat-input/constants';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface QuickActionsDropdownProps {
  actions?: Array<{
    id: string;
    name: string;
    description?: string;
    icon?: string | null;
    content: string;
  }>;
  onAction: (message: string) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcut?: string;
  showShortcut?: boolean;
}

const ICON_MAP: Record<string, LucideIcon> = {
  zap: Zap,
  sparkles: Sparkles,
  terminal: Terminal,
  'git-pull-request': GitPullRequest,
  'message-square-text': MessageSquareText,
};

function getActionIcon(iconName?: string | null): LucideIcon {
  return (iconName && ICON_MAP[iconName]) || Zap;
}

/**
 * Quick actions dropdown for sending predefined messages.
 */
export function QuickActionsDropdown({
  actions,
  onAction,
  disabled,
  open,
  onOpenChange,
  shortcut,
  showShortcut = false,
}: QuickActionsDropdownProps) {
  const shortcutText = showShortcut && shortcut ? ` (${shortcut})` : '';
  const resolvedActions =
    actions ??
    QUICK_ACTIONS.map((action) => ({
      id: action.id,
      name: action.name,
      icon: action.icon,
      content: action.message,
    }));
  const hasActions = resolvedActions.length > 0;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || !hasActions}
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
        {resolvedActions.map((action) => {
          const Icon = getActionIcon(action.icon);
          return (
            <DropdownMenuItem
              key={action.id}
              onClick={() => onAction(action.content)}
              className="gap-2"
            >
              <Icon className="h-4 w-4" />
              {action.name}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
