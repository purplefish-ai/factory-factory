import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { getProjectAgentPath } from '@/client/lib/project-navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { describeAgentSchedule } from './agent-schedule';
import type { Agent } from './types';

type RailAgent = Pick<
  Agent,
  | 'id'
  | 'name'
  | 'prompt'
  | 'cadence'
  | 'isEnabled'
  | 'scheduledTime'
  | 'timezone'
  | 'nextRunAt'
  | 'lastRunAt'
>;
export interface AgentsDashboardShellProps {
  projectSlug: string;
  agents?: RailAgent[];
  selectedAgentId?: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onCreate: () => void;
  onAgentSelect?: (id: string) => void;
  createDisabled?: boolean;
  children: ReactNode;
}

function selectFromLink(
  event: MouseEvent<HTMLAnchorElement>,
  id: string,
  onSelect?: (id: string) => void
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  onSelect?.(id);
}

/** Presentational shell shared by Storybook and the mobile fixture. */
export function AgentsDashboardShell({
  projectSlug,
  agents,
  selectedAgentId,
  isLoading,
  error,
  onRetry,
  onCreate,
  onAgentSelect,
  createDisabled,
  children,
}: AgentsDashboardShellProps) {
  return (
    <div className="@container/agents flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Instructions that run on a schedule, in their own workspaces.
          </p>
        </div>
        <Button size="sm" onClick={onCreate} disabled={createDisabled}>
          <PlusIcon className="size-4" />
          Create Agent
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @[48rem]/agents:flex-row">
        <aside className="flex max-h-64 shrink-0 flex-col border-b bg-muted/15 @[48rem]/agents:max-h-none @[48rem]/agents:w-72 @[48rem]/agents:border-r @[48rem]/agents:border-b-0 @[64rem]/agents:w-80">
          <nav aria-label="Agents" className="min-h-0 overflow-y-auto p-2">
            {error && (
              <div role="alert" className="space-y-2 p-2 text-xs">
                <p className="break-words text-destructive">{error}</p>
                {onRetry && (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    Retry agents
                  </Button>
                )}
              </div>
            )}
            {isLoading && !agents && (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                Loading agents…
              </p>
            )}
            {!(error || isLoading) && agents?.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">No agents in this project.</p>
            )}
            {agents?.map((agent) => (
              <Link
                key={agent.id}
                to={getProjectAgentPath(projectSlug, agent.id)}
                onClick={(event) => selectFromLink(event, agent.id, onAgentSelect)}
                aria-current={agent.id === selectedAgentId ? 'page' : undefined}
                className={cn(
                  'mb-1 block min-w-0 rounded-md border border-transparent p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  agent.id === selectedAgentId && 'border-border bg-background shadow-sm'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <RobotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{agent.name}</span>
                </div>
                <p className="mt-2 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                  {agent.prompt}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      agent.isEnabled ? 'bg-primary' : 'bg-muted-foreground/40'
                    )}
                  />
                  <span>{agent.isEnabled ? 'Active' : 'Paused'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{describeAgentSchedule(agent)}</span>
                </div>
              </Link>
            ))}
          </nav>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl space-y-7 p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
