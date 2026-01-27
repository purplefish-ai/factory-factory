'use client';

import { AlertCircle, Clock, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type InitStatus = 'PENDING' | 'INITIALIZING' | 'READY' | 'FAILED';

interface InitStatusBadgeProps {
  status: InitStatus;
  errorMessage?: string | null;
  className?: string;
}

interface StatusConfig {
  icon: typeof Clock;
  label: string;
  variant: 'outline' | 'secondary' | 'destructive';
  iconClassName?: string;
}

// Only include statuses that are actually rendered (READY returns null)
const statusConfig: Record<Exclude<InitStatus, 'READY'>, StatusConfig> = {
  PENDING: {
    icon: Clock,
    label: 'Pending',
    variant: 'outline',
  },
  INITIALIZING: {
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
};

export function InitStatusBadge({
  status,
  errorMessage,
  className,
}: InitStatusBadgeProps): React.ReactNode {
  if (status === 'READY') {
    return null;
  }

  const config = statusConfig[status];
  const Icon = config.icon;

  const badge = (
    <Badge variant={config.variant} className={cn('gap-1 text-xs', className)}>
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
