import { AlertTriangle, Circle, Loader2, Power } from 'lucide-react';

import type { ProcessStatus, SessionStatus } from '@/components/chat/reducer';
import { cn } from '@/lib/utils';

interface ClaudeProcessStatusProps {
  processStatus: ProcessStatus;
  sessionStatus: SessionStatus;
  className?: string;
}

interface StatusDescriptor {
  title: string;
  description?: string;
  icon: typeof AlertTriangle;
  containerClassName: string;
  iconClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}

function buildStatusDescriptor(
  processStatus: ProcessStatus,
  sessionStatus: SessionStatus
): StatusDescriptor | null {
  if (sessionStatus.phase === 'loading' || processStatus.state === 'unknown') {
    return null;
  }

  if (sessionStatus.phase === 'starting') {
    return {
      title: 'Starting Claude',
      description: 'Launching the CLI process for this session.',
      icon: Loader2,
      containerClassName: 'bg-muted/40 text-muted-foreground',
      iconClassName: 'animate-spin',
    };
  }

  if (sessionStatus.phase === 'stopping') {
    return {
      title: 'Stopping response',
      description: 'Finishing up the current request.',
      icon: Loader2,
      containerClassName: 'bg-muted/40 text-muted-foreground',
      iconClassName: 'animate-spin',
    };
  }

  if (processStatus.state === 'stopped') {
    if (processStatus.lastExit?.unexpected) {
      const codeLabel =
        processStatus.lastExit.code !== null ? `Exit code ${processStatus.lastExit.code}. ` : '';
      return {
        title: 'Claude exited unexpectedly',
        description: `${codeLabel}Send a message to restart the session.`,
        icon: AlertTriangle,
        containerClassName: 'bg-destructive/10 text-destructive',
        titleClassName: 'text-destructive',
        descriptionClassName: 'text-destructive/90',
      };
    }

    if (processStatus.lastExit) {
      return {
        title: 'Claude stopped',
        description: 'Send a message to start it again.',
        icon: Power,
        containerClassName: 'bg-muted/40 text-muted-foreground',
      };
    }

    return {
      title: 'Claude is not running',
      description: 'Send a message to start the session.',
      icon: Power,
      containerClassName: 'bg-muted/40 text-muted-foreground',
    };
  }

  if (sessionStatus.phase === 'running') {
    return {
      title: 'Claude is running',
      description: 'Processing your request.',
      icon: Circle,
      containerClassName: 'bg-brand/10 text-brand',
      iconClassName: 'fill-current',
    };
  }

  return {
    title: 'Claude is idle',
    description: 'Ready for your next message.',
    icon: Circle,
    containerClassName: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    iconClassName: 'fill-current',
  };
}

export function ClaudeProcessStatus({
  processStatus,
  sessionStatus,
  className,
}: ClaudeProcessStatusProps) {
  const descriptor = buildStatusDescriptor(processStatus, sessionStatus);
  if (!descriptor) {
    return null;
  }

  const Icon = descriptor.icon;

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-4 py-2 border-b text-xs',
        descriptor.containerClassName,
        className
      )}
    >
      <Icon className={cn('h-4 w-4 mt-0.5', descriptor.iconClassName)} />
      <div className="flex flex-col">
        <span className={cn('font-medium', descriptor.titleClassName)}>{descriptor.title}</span>
        {descriptor.description && (
          <span className={cn('text-xs', descriptor.descriptionClassName)}>
            {descriptor.description}
          </span>
        )}
      </div>
    </div>
  );
}
