import { formatDistanceToNow } from 'date-fns';
import { Archive, Clock, MessageSquare } from 'lucide-react';
import { useState } from 'react';
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

  const { data: closedSessions, isLoading } = trpc.closedSessions.list.useQuery(
    {
      workspaceId,
      limit: 20,
    },
    {
      enabled: open, // Only fetch when dropdown is opened
    }
  );

  const hasClosedSessions = closedSessions && closedSessions.length > 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              className={cn(
                'h-7 px-2 text-xs gap-1.5',
                'text-muted-foreground hover:text-foreground',
                'border border-input bg-background hover:bg-sidebar-accent'
              )}
            >
              <Archive className="h-3.5 w-3.5" />
              <span>Closed</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>View closed session history</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Closed Sessions</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {isLoading && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading closed sessions...
          </div>
        )}

        {!(isLoading || hasClosedSessions) && (
          <div className="py-6 px-2 text-center text-sm text-muted-foreground">
            No closed sessions yet. Ratchet sessions will appear here after they complete.
          </div>
        )}

        {!isLoading && hasClosedSessions && (
          <ScrollArea className="max-h-96">
            {closedSessions.map((session) => (
              <DropdownMenuItem
                key={session.id}
                onClick={() => {
                  onSelectClosedSession(session.id);
                  setOpen(false);
                }}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer"
              >
                <MessageSquare className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {session.name || `${session.workflow} session`}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
