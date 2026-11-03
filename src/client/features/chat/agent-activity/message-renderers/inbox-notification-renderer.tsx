import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { useState } from 'react';
import { WorkspaceInboxPanel } from '@/client/features/inbox';
import type { InboxNotification } from './workspace-inbox-notification';

export function InboxNotificationRenderer({
  notification,
  queued = false,
}: {
  notification: InboxNotification;
  queued?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group min-w-0 py-1" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <EnvelopeSimpleIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {notification.kind === 'mail' ? 'Workspace mail' : notification.title}
          {queued && <span> · queued for next turn</span>}
        </span>
        <CaretRightIcon
          className="size-3 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      {notification.kind === 'mail' ? (
        open && (
          <div className="mt-2 overflow-hidden rounded-md border border-border/60">
            <p className="border-b px-3 py-2 text-xs text-muted-foreground">
              Current inbox · notification at revision {notification.revision}
            </p>
            <div className="h-96 max-h-[60vh] min-h-0">
              <WorkspaceInboxPanel workspaceId={notification.workspaceId} />
            </div>
          </div>
        )
      ) : (
        <p className="mt-2 pl-5.5 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {notification.body}
        </p>
      )}
    </details>
  );
}
