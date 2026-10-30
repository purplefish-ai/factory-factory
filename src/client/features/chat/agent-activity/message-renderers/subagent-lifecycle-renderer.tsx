import { SubagentIcon } from '@/client/components/subagent-icon';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

export function SubagentLifecycleRenderer({
  message,
  onOpenAgents,
}: {
  message: ChatMessage;
  onOpenAgents?: () => void;
}) {
  const text = message.message?.text ?? message.text ?? 'Sub-agent';
  const failed = message.message?.status === 'failed';
  const content = (
    <>
      <SubagentIcon index={message.subagentIconIndex ?? 0} />
      <span className={cn('min-w-0 break-words', failed && 'text-destructive')}>{text}</span>
    </>
  );
  const className =
    'flex max-w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground';
  return onOpenAgents ? (
    <button
      type="button"
      title="Open Sessions panel"
      onClick={onOpenAgents}
      className={cn(
        className,
        'rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

export function isSubagentLifecycleMessage(
  message: AgentMessage | undefined
): message is AgentMessage & { type: 'system' } {
  return (
    message?.type === 'system' &&
    (message.subtype === 'subagent_started' || message.subtype === 'subagent_finished')
  );
}
