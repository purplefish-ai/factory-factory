import { SubagentIcon } from '@/client/components/subagent-icon';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

export function SubagentLifecycleRenderer({
  message,
  onOpenSubagent,
}: {
  message: ChatMessage;
  onOpenSubagent?: (subagentId: string) => void;
}) {
  const text = message.message?.text ?? message.text ?? 'Subagent';
  const failed = message.message?.status === 'failed';
  const content = (
    <>
      <SubagentIcon index={message.subagentIconIndex ?? 0} />
      <span className={cn('min-w-0 break-words', failed && 'text-destructive')}>{text}</span>
    </>
  );
  const className =
    'flex max-w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground';
  const subagentId = message.subagentId;
  return onOpenSubagent && subagentId ? (
    <button
      type="button"
      title="Open subagent tab"
      onClick={() => onOpenSubagent(subagentId)}
      className={cn(className, 'rounded-sm transition-colors hover:text-foreground focus-ring')}
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
