import { WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import type { AgentMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

interface SessionLifecycleMessageRendererProps {
  message: AgentMessage;
  className?: string;
}

const ERROR_REASONS = new Set(['PROVIDER_ERROR', 'UNEXPECTED_EXIT']);

export function SessionLifecycleMessageRenderer({
  message,
  className,
}: SessionLifecycleMessageRendererProps): React.JSX.Element | null {
  if (!message.lifecycle) {
    return null;
  }

  const isError = ERROR_REASONS.has(message.lifecycle.reason);
  const Icon = isError ? XCircleIcon : WarningCircleIcon;

  return (
    <div
      data-testid="session-lifecycle-message"
      data-severity={isError ? 'error' : 'warning'}
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        isError
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-amber-500/30 bg-amber-500/5 text-muted-foreground',
        className
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-words">{message.lifecycle.message}</p>
        <time className="mt-0.5 block text-xs opacity-80" dateTime={message.lifecycle.timestamp}>
          {new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(message.lifecycle.timestamp))}
        </time>
      </div>
    </div>
  );
}
