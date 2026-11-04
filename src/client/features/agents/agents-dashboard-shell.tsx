import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { getProjectAgentPath } from '@/client/lib/project-navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { describeAgentSchedule } from './agent-schedule';
import type { Agent, EventAgentSummary } from './types';

type ScheduledRailAgent = Pick<
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
> & { kind?: 'scheduled' };
type RailAgent = ScheduledRailAgent | (EventAgentSummary & { kind: 'event' });
export interface AgentsDashboardShellProps {
  projectSlug: string;
  agents?: RailAgent[];
  selectedAgentId?: string;
  selectedKind?: 'scheduled' | 'event';
  continuation?: ReactNode;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onCreate: (kind: 'scheduled' | 'event') => void;
  onAgentSelect?: (id: string) => void;
  createDisabled?: boolean;
  children: ReactNode;
}

function CreateAgentMenu({
  onCreate,
  disabled,
  outline = false,
}: {
  onCreate: AgentsDashboardShellProps['onCreate'];
  disabled?: boolean;
  outline?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={outline ? 'outline' : 'default'} disabled={disabled}>
          <PlusIcon className="size-4" aria-hidden="true" />
          Create agent
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onCreate('scheduled')}>Scheduled agent</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCreate('event')}>Event agent</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

function AgentRailItem({
  agent,
  projectSlug,
  selected,
  onAgentSelect,
}: {
  agent: RailAgent;
  projectSlug: string;
  selected: boolean;
  onAgentSelect?: (id: string) => void;
}) {
  return (
    <Link
      to={getProjectAgentPath(projectSlug, agent.id, agent.kind)}
      onClick={(event) => selectFromLink(event, agent.id, onAgentSelect)}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'mb-1 block min-w-0 rounded-md border border-transparent p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-border bg-background shadow-sm'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RobotIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{agent.name}</span>
      </div>
      {agent.kind !== 'event' && (
        <p className="mt-2 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
          {agent.prompt}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span
          className={cn(
            'size-1.5 rounded-full',
            agent.isEnabled ? 'bg-primary' : 'bg-muted-foreground/40'
          )}
        />
        <span>
          {agent.isEnabled ? (agent.kind === 'event' ? 'Definition enabled' : 'Active') : 'Paused'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{agent.kind === 'event' ? 'Event' : describeAgentSchedule(agent)}</span>
      </div>
    </Link>
  );
}

/** Presentational shell shared by Storybook and the mobile fixture. */
export function AgentsDashboardShell({
  projectSlug,
  agents,
  selectedAgentId,
  selectedKind = 'scheduled',
  continuation,
  isLoading,
  error,
  onRetry,
  onCreate,
  onAgentSelect,
  createDisabled,
  children,
}: AgentsDashboardShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const [revealRequest, setRevealRequest] = useState(0);
  const previousSelection = useRef(selectedAgentId);
  useLayoutEffect(() => {
    const changed = previousSelection.current !== selectedAgentId;
    previousSelection.current = selectedAgentId;
    if (!((revealRequest || changed) && contentRef.current && editorRef.current)) {
      return;
    }
    if (getComputedStyle(contentRef.current).flexDirection !== 'column') {
      return;
    }
    editorRef.current.focus({ preventScroll: true });
    editorRef.current.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [revealRequest, selectedAgentId]);
  const selectAgent = (id: string) => {
    onAgentSelect?.(id);
    setRevealRequest((request) => request + 1);
  };
  const createAgent = (...args: Parameters<typeof onCreate>) => {
    onCreate(...args);
    setRevealRequest((request) => request + 1);
  };
  return (
    <div className="@container/agents flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Scheduled and event agents in this project.
          </p>
        </div>
        <CreateAgentMenu onCreate={createAgent} disabled={createDisabled} />
      </header>
      <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @[48rem]/agents:flex-row @[48rem]/agents:overflow-hidden">
        <aside className="flex shrink-0 flex-col border-b bg-muted/15 @[48rem]/agents:max-h-none @[48rem]/agents:w-72 @[48rem]/agents:border-r @[48rem]/agents:border-b-0 @[64rem]/agents:w-80">
          <nav aria-label="Agents" className="min-h-0 overflow-visible p-2 @[48rem]/agents:overflow-y-auto">
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
            {isLoading && <Loading size="compact" message="Loading agents…" />}
            {!(error || isLoading) && agents?.length === 0 && (
              <EmptyState
                size="compact"
                icon={RobotIcon}
                title="No agents yet"
                description="Schedule recurring work or prepare an event agent."
                action={<CreateAgentMenu onCreate={createAgent} disabled={createDisabled} outline />}
              />
            )}
            {(!!agents?.length || continuation) &&
              (['scheduled', 'event'] as const).map((kind) => (
                <section
                  key={kind}
                  aria-label={kind === 'scheduled' ? 'Scheduled' : 'Event'}
                  className="mb-3"
                >
                  <h2 className="px-3 py-2 text-xs font-semibold text-muted-foreground">
                    {kind === 'scheduled' ? 'Scheduled' : 'Event'}
                  </h2>
                  {agents
                    ?.filter((agent) => (agent.kind ?? 'scheduled') === kind)
                    .map((agent) => (
                      <AgentRailItem
                        key={`${projectSlug}:${kind}:${agent.id}`}
                        agent={agent}
                        projectSlug={projectSlug}
                        onAgentSelect={selectAgent}
                        selected={agent.id === selectedAgentId && kind === selectedKind}
                      />
                    ))}
                  {kind === 'event' && continuation}
                </section>
              ))}
          </nav>
        </aside>
        <main ref={editorRef} tabIndex={-1} aria-label="Agent details" className="min-h-0 min-w-0 flex-none overflow-visible @[48rem]/agents:flex-1 @[48rem]/agents:overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl space-y-7 p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
