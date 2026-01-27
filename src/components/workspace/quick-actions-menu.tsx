'use client';

import type { inferRouterOutputs } from '@trpc/server';
import { Check, Eye, type LucideIcon, Play, Sparkles, Terminal, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AppRouter } from '@/frontend/lib/trpc';
import { trpc } from '@/frontend/lib/trpc';

// =============================================================================
// Types
// =============================================================================

type RouterOutputs = inferRouterOutputs<AppRouter>;
type QuickAction = NonNullable<RouterOutputs['session']['listQuickActions']>[number];

interface QuickActionsMenuProps {
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
};

function getActionIcon(iconName?: string): LucideIcon {
  return (iconName && ICON_MAP[iconName]) || Zap;
}

// =============================================================================
// Component
// =============================================================================

export function QuickActionsMenu({ onExecuteAgent, disabled = false }: QuickActionsMenuProps) {
  const { data: quickActions, isLoading } = trpc.session.listQuickActions.useQuery();

  // Only show agent actions for now (script actions not yet implemented)
  const agentActions = quickActions?.filter((a) => a.type === 'agent') ?? [];

  const hasActions = agentActions.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={disabled || isLoading || !hasActions}
          title="Quick Actions"
        >
          <Zap className="h-4 w-4" />
          <span className="sr-only">Quick Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Quick Actions</DropdownMenuLabel>
        {agentActions.map((action) => {
          const Icon = getActionIcon(action.icon ?? undefined);
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
  );
}
