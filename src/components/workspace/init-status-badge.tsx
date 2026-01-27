'use client';

import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type InitStatus = 'PENDING' | 'INITIALIZING' | 'READY' | 'FAILED';

interface InitStatusBadgeProps {
  status: InitStatus;
  errorMessage?: string | null;
  className?: string;
}

const statusConfig: Record<
  InitStatus,
  {
    icon: typeof Clock;
    label: string;
    variant: 'outline' | 'secondary' | 'success' | 'destructive';
    iconClassName?: string;
  }
> = {
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
  READY: {
    icon: CheckCircle2,
    label: 'Ready',
    variant: 'success',
  },
  FAILED: {
    icon: AlertCircle,
    label: 'Setup failed',
    variant: 'destructive',
  },
};

export function InitStatusBadge({ status, errorMessage, className }: InitStatusBadgeProps) {
  // Don't render anything for READY status
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
