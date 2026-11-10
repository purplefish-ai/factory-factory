import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ChatIcon } from '@phosphor-icons/react/dist/csr/Chat';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { formatDistanceToNow } from 'date-fns';
import { useState } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { QueryState } from '@/client/components/query-state';
import { getSessionDisplayName } from '@/client/lib/session-display-name';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ClosedSessionsDropdownProps {
  workspaceId: string;
  onSelectClosedSession: (sessionId: string) => void;
  disabled?: boolean;
}

export function ClosedSessionsDropdown({
  workspaceId,
  onSelectClosedSession,
  disabled,
}: ClosedSessionsDropdownProps) {
  const [open, setOpen] = useState(false);

  const closedSessions = trpc.closedSessions.list.useQuery({ workspaceId, limit: 20 });

  // Hide the button only when the list loaded empty; a failed load stays reachable.
  if (closedSessions.data?.length === 0 && !closedSessions.error) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="compact"
              disabled={disabled}
              className={cn(
                'text-muted-foreground hover:text-foreground',
                'border border-input bg-background hover:bg-sidebar-accent'
              )}
            >
              <ArchiveIcon />
              <span>Closed</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>View closed session history</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Closed Sessions</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <QueryState
          query={closedSessions}
          errorTitle="Couldn't load closed sessions"
          loadingMessage="Loading closed sessions…"
          size="compact"
          className="p-3"
          isEmpty={(sessions) => sessions.length === 0}
          empty={
            <EmptyState
              size="compact"
              title="No closed sessions yet"
              description="Ratchet sessions will appear here after they complete."
            />
          }
        >
          {(sessions) => (
            <ScrollArea className="max-h-96">
              {sessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onClick={() => {
                    onSelectClosedSession(session.id);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2 px-3 py-2 cursor-pointer"
                >
                  {session.workflow === 'periodic-task' ? (
                    <RobotIcon
                      aria-label="Agent session"
                      className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground"
                    />
                  ) : (
                    <ChatIcon className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {getSessionDisplayName(session, `${session.workflow} session`)}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                      <ClockIcon className="h-3 w-3 shrink-0" />
                      <span>
                        {formatDistanceToNow(new Date(session.completedAt), { addSuffix: true })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                      <span className="capitalize">{session.provider.toLowerCase()}</span>
                      <span>•</span>
                      <span>{session.model}</span>
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </ScrollArea>
          )}
        </QueryState>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
