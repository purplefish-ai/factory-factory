import { CalendarIcon } from '@phosphor-icons/react/dist/csr/Calendar';
import type { ReactNode } from 'react';
import { formatDateTime, toDateTimeIso } from '@/client/lib/date-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { describeAgentSchedule } from './agent-schedule';
import type { Agent } from './types';

export interface AgentDetailProps {
  agent: Agent;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  /** Any action on this agent is in flight; its controls are disabled. */
  pending?: boolean;
  /** The pause or resume request is in flight. */
  toggling?: boolean;
  error?: string | null;
  children?: ReactNode;
}
export function AgentDetail({
  agent,
  onEdit,
  onToggle,
  onDelete,
  pending,
  toggling = false,
  error,
  children,
}: AgentDetailProps) {
  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold tracking-tight">{agent.name}</h2>
          </div>
          <Badge variant="secondary">{agent.isEnabled ? 'Active' : 'Paused'}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={pending}>
            Edit automation
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggle}
            disabled={pending}
            pending={toggling}
            pendingLabel={agent.isEnabled ? 'Pausing…' : 'Resuming…'}
          >
            {agent.isEnabled ? 'Pause' : 'Resume'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            disabled={pending}
          >
            Delete
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Pause affects future runs. A running workspace continues unchanged.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <section className="space-y-3 border-t pt-6">
        <h3 className="text-sm font-semibold">Instructions</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
          {agent.prompt}
        </p>
      </section>
      <section className="space-y-3 rounded-lg border bg-muted/15 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarIcon className="size-4 text-muted-foreground" />
          Schedule
        </h3>
        <p className="break-words text-sm">{describeAgentSchedule(agent)}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            Last run:{' '}
            {agent.lastRunAt ? (
              <time
                dateTime={toDateTimeIso(agent.lastRunAt)}
                title={formatDateTime(agent.lastRunAt, { precision: 'second' })}
              >
                {formatDateTime(agent.lastRunAt)}
              </time>
            ) : (
              'No runs yet'
            )}
          </span>
          <span>
            Next run:{' '}
            {agent.isEnabled ? (
              <time
                dateTime={toDateTimeIso(agent.nextRunAt)}
                title={formatDateTime(agent.nextRunAt, { precision: 'second' })}
              >
                {formatDateTime(agent.nextRunAt)}
              </time>
            ) : (
              'Paused'
            )}
          </span>
        </div>
      </section>
      <div className="border-t pt-6">{children}</div>
    </>
  );
}
