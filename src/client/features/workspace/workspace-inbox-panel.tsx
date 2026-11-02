import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkspaceMailSummary } from '@/shared/workspace-mail';
import { WorkspaceMailDetail } from './workspace-mail-detail';
import { MailMetadata } from './workspace-mail-metadata';

export function WorkspaceInboxPanel({ workspaceId }: { workspaceId: string }) {
  // A workspace change discards selection and any in-flight body view.
  return <WorkspaceInbox key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceInbox({ workspaceId }: { workspaceId: string }) {
  const utils = trpc.useUtils();
  const retryWake = trpc.workspace.retryMailWake.useMutation({
    onSuccess: () => {
      void utils.workspace.listMail.invalidate({ workspaceId });
    },
  });
  const [selected, setSelected] = useState<WorkspaceMailSummary | null>(null);
  const mail = trpc.workspace.listMail.useInfiniteQuery(
    { workspaceId, limit: 20 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 15_000 }
  );
  const items = [
    ...new Map(
      mail.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item])
    ).values(),
  ];
  const unread = items.filter(
    (item) => !(item.readAt || item.acknowledgedAt || item.supersededAt)
  ).length;

  if (selected) {
    return (
      <WorkspaceMailDetail
        workspaceId={workspaceId}
        mail={selected}
        onBack={() => setSelected(null)}
      />
    );
  }
  return (
    <section aria-label="Workspace inbox" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <EnvelopeSimpleIcon className="size-4 text-muted-foreground" />
          <h2>Inbox</h2>
          {mail.data && (
            <span className="text-muted-foreground">
              {unread} unread{mail.hasNextPage ? ' loaded' : ''}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={mail.isFetching}
          onClick={() => void mail.refetch()}
        >
          Refresh
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mail.data?.pages.at(-1)?.wakeAmbiguous && (
          <div className="space-y-2 border-b bg-muted/30 p-3 text-xs">
            <p>Delivery could not be confirmed. Retrying may notify the agent again.</p>
            <Button
              variant="outline"
              size="sm"
              disabled={retryWake.isPending}
              onClick={() => retryWake.mutate({ workspaceId })}
            >
              {retryWake.isPending ? 'Retrying notification…' : 'Retry mail notification'}
            </Button>
            {retryWake.isError && (
              <p role="alert" className="text-destructive">
                Could not retry mail notification. {retryWake.error.message}
              </p>
            )}
          </div>
        )}
        {mail.isLoading && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading inbox…
          </p>
        )}
        {mail.isError && (
          <div role="alert" className="space-y-2 p-4 text-sm">
            <p>Could not load inbox. {mail.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void (mail.isFetchNextPageError ? mail.fetchNextPage() : mail.refetch())
              }
            >
              Try again
            </Button>
          </div>
        )}
        {mail.data && items.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No messages yet.</p>
        )}
        <ul className="divide-y divide-border/50">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full space-y-1.5 px-3 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => setSelected(item)}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className={cn('break-words text-sm', !item.readAt && 'font-semibold')}>
                    {item.subject || 'Workspace message'}
                  </span>
                  {!(item.readAt || item.acknowledgedAt || item.supersededAt) && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                      Unread
                    </span>
                  )}
                </div>
                <MailMetadata mail={item} />
                <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                  {item.preview}
                </p>
                {item.acknowledgedAt && (
                  <p className="text-xs text-muted-foreground">Acknowledged</p>
                )}
                {item.supersededAt && (
                  <p className="text-xs text-muted-foreground">
                    A newer progress update is available
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
        {mail.hasNextPage && (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={mail.isFetching}
              onClick={() => void mail.fetchNextPage()}
            >
              {mail.isFetchingNextPage ? 'Loading messages…' : 'Load older messages'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
