import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { useEffect, useState } from 'react';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import type { WorkspaceMailSummary } from '@/shared/workspace-mail';
import { MailMetadata } from './workspace-mail-metadata';

export function WorkspaceMailDetail({
  workspaceId,
  mail,
  onBack,
}: {
  workspaceId: string;
  mail: WorkspaceMailSummary;
  onBack: () => void;
}) {
  const utils = trpc.useUtils();
  const [body, setBody] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [observedRevision, setObservedRevision] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(!!mail.acknowledgedAt);
  // Mutation-level callbacks survive a detail unmount; per-call UI callbacks do not.
  const invalidateInbox = () => {
    void utils.workspace.listMail.invalidate({ workspaceId });
    void utils.workspace.unreadMailCounts.invalidate();
  };
  const read = trpc.workspace.readMail.useMutation({
    meta: { errorToast: false },
    onSuccess: invalidateInbox,
  });
  const ack = trpc.workspace.ackMail.useMutation({
    meta: { errorToast: false },
    onSuccess: invalidateInbox,
  });
  const { mutate: readBody } = read;

  useEffect(() => {
    let active = true;
    readBody(
      { workspaceId, ids: [mail.id], offset: 0, maxChars: 8192 },
      {
        onSuccess: (result) => {
          if (!active) {
            return;
          }
          const item = result.items.find((item) => item.id === mail.id);
          if (!item) {
            setReadError('This message is no longer available.');
            return;
          }
          setBody(item.body);
          setNextOffset(item.nextOffset);
          setObservedRevision(result.revision);
        },
        onError: (error) => {
          if (active) {
            setReadError(error.message);
          }
        },
      }
    );
    return () => {
      active = false;
    };
  }, [workspaceId, mail.id, readBody]);

  function readMore(offset: number) {
    setReadError(null);
    read.mutate(
      { workspaceId, ids: [mail.id], offset, maxChars: 8192 },
      {
        onSuccess: (result) => {
          const item = result.items.find((item) => item.id === mail.id);
          if (!item) {
            setReadError('This message is no longer available.');
            return;
          }
          setBody((current) => (offset === 0 ? item.body : current + item.body));
          setNextOffset(item.nextOffset);
          setObservedRevision(result.revision);
        },
        onError: (error) => setReadError(error.message),
      }
    );
  }
  return (
    <section aria-label="Message" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="mr-1 size-3.5" />
          Inbox
        </Button>
        <Button
          data-mail-ack
          variant="outline"
          size="sm"
          disabled={
            acknowledged ||
            observedRevision === null ||
            nextOffset !== null ||
            ack.isPending ||
            read.isPending
          }
          onClick={() => {
            if (observedRevision === null || nextOffset !== null) {
              return;
            }
            setAckError(null);
            ack.mutate(
              { workspaceId, ids: [mail.id], throughRevision: observedRevision },
              {
                onSuccess: (result) => {
                  if (result.acknowledged > 0) {
                    setAcknowledged(true);
                  } else {
                    // Zero may be an idempotent success, but only this exact ID can prove it.
                    read.mutate(
                      { workspaceId, ids: [mail.id], offset: 0, maxChars: 2 },
                      {
                        onSuccess: (result) => {
                          const item = result.items.find((item) => item.id === mail.id);
                          if (item?.acknowledgedAt) {
                            setAcknowledged(true);
                          } else {
                            setAckError('Refresh the inbox and try again.');
                          }
                        },
                        onError: (error) => setAckError(error.message),
                      }
                    );
                  }
                },
                onError: (error) => setAckError(error.message),
              }
            );
          }}
        >
          {acknowledged ? 'Acknowledged' : ack.isPending ? 'Acknowledging…' : 'Acknowledge'}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <h2 className="mb-2 break-words text-sm font-semibold">
          {mail.subject || 'Workspace message'}
        </h2>
        <MailMetadata mail={mail} />
        <p className="my-3 text-xs text-muted-foreground">
          {nextOffset !== null
            ? 'Read the full message before acknowledging receipt.'
            : 'Acknowledging confirms receipt of this message.'}
        </p>
        {ackError && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            Couldn't acknowledge message. {ackError}
          </p>
        )}
        {body && (
          <div className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
            {body}
          </div>
        )}
        {read.isPending && (
          <Loading size="compact" message="Loading message…" className="mt-3 h-auto" />
        )}
        {readError && (
          <QueryErrorState
            title="Couldn't read message"
            error={{ message: readError }}
            onRetry={() => readMore(observedRevision === null ? 0 : (nextOffset ?? 0))}
            isRetrying={read.isPending}
            className="mt-3 p-3"
          />
        )}
        {nextOffset !== null && !readError && (
          <Button
            className="mt-4"
            variant="outline"
            size="sm"
            disabled={read.isPending}
            onClick={() => readMore(nextOffset)}
          >
            Read more
          </Button>
        )}
      </div>
    </section>
  );
}
