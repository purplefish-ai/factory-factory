import { AlertCircle, Clock, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkspaceStatus } from '@/shared/core';

export type { WorkspaceStatus };

interface WorkspaceStatusBadgeProps {
  status: WorkspaceStatus;
  errorMessage?: string | null;
  className?: string;
}

interface StatusConfig {
  icon: typeof Clock;
  label: string;
  variant: 'outline' | 'secondary' | 'destructive';
  iconClassName?: string;
}

// Only include statuses that are actually rendered (READY/ARCHIVED return null)
const statusConfig: Record<Exclude<WorkspaceStatus, 'READY' | 'ARCHIVED'>, StatusConfig> = {
  NEW: {
    icon: Clock,
    label: 'Pending',
    variant: 'outline',
  },
  PROVISIONING: {
    icon: Loader2,
    label: 'Setting up',
    variant: 'secondary',
    iconClassName: 'animate-spin',
  },
  FAILED: {
    icon: AlertCircle,
    label: 'Setup failed',
    variant: 'destructive',
  },
  ARCHIVING: {
    icon: Loader2,
    label: 'Archiving',
    variant: 'secondary',
    iconClassName: 'animate-spin',
  },
};

export function WorkspaceStatusBadge({
  status,
  errorMessage,
  className,
}: WorkspaceStatusBadgeProps): React.ReactNode {
  // Don't show badge for READY or ARCHIVED workspaces
  if (status === 'READY' || status === 'ARCHIVED') {
    return null;
  }

  const config = statusConfig[status];
  const Icon = config.icon;

  const badge = (
    <Badge
      variant={config.variant}
      className={cn('gap-1 text-xs whitespace-nowrap shrink-0', className)}
    >
      <Icon className={cn('h-3 w-3', config.iconClassName)} />
      {config.label}
    </Badge>
  );

  // Show tooltip with error message for failed status
  if (status === 'FAILED' && errorMessage) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-[300px]">
            <p className="text-xs">{errorMessage}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return badge;
}
