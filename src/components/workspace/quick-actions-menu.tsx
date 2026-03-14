import type { inferRouterOutputs } from '@trpc/server';
import {
  Camera,
  Check,
  Eye,
  GitBranch,
  GitPullRequest,
  type LucideIcon,
  MessageSquareText,
  Play,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type { AppRouter } from '@/client/lib/trpc';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// =============================================================================
// Types
// =============================================================================

type RouterOutputs = inferRouterOutputs<AppRouter>;
type QuickAction = NonNullable<RouterOutputs['session']['listQuickActions']>[number];

interface QuickActionsMenuProps {
  workspaceId?: string;
  onExecuteAgent: (action: QuickAction) => void;
  disabled?: boolean;
}

// =============================================================================
// Icon Mapping
// =============================================================================

const ICON_MAP: Record<string, LucideIcon> = {
  zap: Zap,
  sparkles: Sparkles,
  eye: Eye,
  play: Play,
  terminal: Terminal,
  check: Check,
  camera: Camera,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  'message-square-text': MessageSquareText,
};

function getActionIcon(iconName?: string | null): LucideIcon {
  return (iconName && ICON_MAP[iconName]) || Zap;
}

// =============================================================================
// Component
// =============================================================================

export function QuickActionsMenu({
  workspaceId,
  onExecuteAgent,
  disabled = false,
}: QuickActionsMenuProps) {
  const canLoad = Boolean(workspaceId);
  const { data: quickActions, isLoading } = trpc.session.listQuickActions.useQuery(
    { workspaceId: workspaceId ?? '', surface: 'sessionBar' },
    { enabled: canLoad }
  );

  const agentActions = quickActions?.filter((action) => action.mode === 'newSession') ?? [];
  const pinnedActions = agentActions.filter((action) => action.pinned);
  const overflowActions = agentActions.filter((action) => !action.pinned);
  const showOverflowMenu =
    overflowActions.length > 0 ||
    (pinnedActions.length === 0 && canLoad && agentActions.length > 0);

  return (
    <div className="flex items-center gap-0.5">
      {pinnedActions.map((action) => {
        const Icon = getActionIcon(action.icon);
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={disabled || isLoading || !canLoad}
                onClick={() => onExecuteAgent(action)}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{action.name}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{action.description || action.name}</TooltipContent>
          </Tooltip>
        );
      })}

      {showOverflowMenu && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={disabled || isLoading || !canLoad || agentActions.length === 0}
                >
                  <Zap className="h-4 w-4" />
                  <span className="sr-only">Quick Actions</span>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Quick Actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Quick Actions</DropdownMenuLabel>
            {overflowActions.map((action) => {
              const Icon = getActionIcon(action.icon);
              return (
                <DropdownMenuItem
                  key={action.id}
                  onClick={() => onExecuteAgent(action)}
                  className="cursor-pointer"
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <div className="flex flex-col">
                    <span>{action.name}</span>
                    <span className="text-xs text-muted-foreground">{action.description}</span>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
