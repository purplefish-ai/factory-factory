import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { useCopyToClipboard } from '@/client/hooks/use-copy-to-clipboard';
import { formatDateTime, toDateTimeIso } from '@/client/lib/date-time';
import { Button } from '@/components/ui/button';
import type { EventAgent } from './types';

type PendingVerification = NonNullable<
  EventAgent['configuredTriggers'][number]['pendingVerification']
>;

/**
 * The test message a starting Slack trigger waits for: post it in each
 * selected channel before it expires. The trigger starts listening once every
 * channel has it; the detail refreshes on its own, so no action is needed here.
 */
export function SlackVerification({ pending }: { pending: PendingVerification }) {
  const { copied, copy } = useCopyToClipboard();
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;
  const received = pending.channels.filter((channel) => channel.verified).length;
  return (
    <section aria-label="Slack test message" className="space-y-2 rounded-md bg-muted/50 p-3">
      <p>
        Post this message in{' '}
        {pending.channels.length === 1
          ? 'the channel'
          : `each of the ${pending.channels.length} channels`}{' '}
        below. Factory Factory starts listening once it sees the message, and never runs it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded border bg-background px-2 py-1 font-mono text-sm">
          {pending.message}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy(pending.message)}
        >
          <CopyStateIcon aria-hidden="true" />
          {copied ? 'Copied' : 'Copy message'}
        </Button>
      </div>
      <ul className="space-y-1" aria-label="Channels" aria-live="polite">
        {pending.channels.map((channel) => (
          <li key={channel.channelId} className="flex flex-wrap justify-between gap-2">
            <span className="min-w-0 break-words">{channel.name ?? channel.channelId}</span>
            <span className={channel.verified ? 'text-success' : 'text-muted-foreground'}>
              {channel.verified ? 'Received' : 'Waiting'}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {received} of {pending.channels.length} received · Expires{' '}
        <time dateTime={toDateTimeIso(pending.expiresAt)}>
          {formatDateTime(pending.expiresAt, { precision: 'second' })}
        </time>
        . If it expires, enable the automation again for a new message.
      </p>
    </section>
  );
}
