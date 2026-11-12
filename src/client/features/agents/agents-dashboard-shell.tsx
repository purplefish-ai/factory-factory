import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { StatusDot } from '@/client/components/status-indicators';
import { getProjectAgentPath } from '@/client/lib/project-navigation';
import type { StatusTone } from '@/client/lib/status-tones';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { describeAgentSchedule } from './agent-schedule';
import { type AutomationState, automationStateFromCounts } from './event-trigger-status';
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
  revealEditorOnMount?: boolean;
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
  const pendingCreation = useRef<'scheduled' | 'event' | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={outline ? 'outline' : 'default'} disabled={disabled}>
          <PlusIcon className="size-4" aria-hidden="true" />
          Create automation
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const kind = pendingCreation.current;
          pendingCreation.current = null;
          if (kind) {
            // Let the new form own focus after the menu's focus scope has closed.
            event.preventDefault();
            onCreate(kind);
          }
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            pendingCreation.current = 'scheduled';
          }}
        >
          Scheduled automation
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            pendingCreation.current = 'event';
          }}
        >
          Event-triggered automation
        </DropdownMenuItem>
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

const EVENT_STATE_TONES: Record<AutomationState, StatusTone> = {
  Active: 'success',
  Starting: 'working',
  Paused: 'neutral',
};

/** The rail's state words: scheduled tasks by their flag, event automations by their triggers. */
function railState(agent: RailAgent): { label: AutomationState; tone: StatusTone } {
  if (agent.kind === 'event') {
    // The definition flag stays on when an edit, expiry or source reset pauses every trigger.
    const label = automationStateFromCounts(agent.triggerStates);
    return { label, tone: EVENT_STATE_TONES[label] };
  }
  return agent.isEnabled
    ? { label: 'Active', tone: 'success' }
    : { label: 'Paused', tone: 'neutral' };
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
  const state = railState(agent);
  return (
    <Link
      to={getProjectAgentPath(projectSlug, agent.id, agent.kind)}
      state={{ revealAgentEditor: true }}
      onClick={(event) => selectFromLink(event, agent.id, onAgentSelect)}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'mb-1 block min-w-0 rounded-md border border-transparent p-3 transition-colors hover:bg-muted focus-ring',
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
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        <StatusDot tone={state.tone} size="xs" />
        <span>{state.label}</span>
        <span aria-hidden="true">·</span>
        <span>{agent.kind === 'event' ? 'Event-triggered' : describeAgentSchedule(agent)}</span>
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
  revealEditorOnMount = false,
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
  const [revealRequest, setRevealRequest] = useState(revealEditorOnMount ? 1 : 0);
  const handledReveal = useRef(0);
  const previousSelection = useRef(selectedAgentId);
  useLayoutEffect(() => {
    const changed = previousSelection.current !== selectedAgentId;
    previousSelection.current = selectedAgentId;
    if (
      !(
        (revealRequest > handledReveal.current || changed) &&
        !isLoading &&
        contentRef.current &&
        editorRef.current
      )
    ) {
      return;
    }
    handledReveal.current = revealRequest;
    if (getComputedStyle(contentRef.current).flexDirection !== 'column') {
      return;
    }
    if (!editorRef.current.contains(document.activeElement)) {
      editorRef.current.focus({ preventScroll: true });
    }
    editorRef.current.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [revealRequest, selectedAgentId, isLoading]);
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
          <h1 className="text-lg font-semibold tracking-tight">Automations</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Run AI agents on a schedule or when events happen.
          </p>
        </div>
        <CreateAgentMenu onCreate={createAgent} disabled={createDisabled} />
      </header>
      <div
        ref={contentRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @[48rem]/agents:flex-row @[48rem]/agents:overflow-hidden"
      >
        <aside className="flex shrink-0 flex-col border-b bg-muted/15 @[48rem]/agents:max-h-none @[48rem]/agents:w-72 @[48rem]/agents:border-r @[48rem]/agents:border-b-0 @[64rem]/agents:w-80">
          <nav
            aria-label="Automations"
            className="min-h-0 overflow-visible p-2 @[48rem]/agents:overflow-y-auto"
          >
            {error && (
              <div role="alert" className="space-y-2 p-2 text-xs">
                <p className="break-words text-destructive">{error}</p>
                {onRetry && (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    Retry automations
                  </Button>
                )}
              </div>
            )}
            {isLoading && <Loading size="compact" message="Loading automations…" />}
            {!(error || isLoading) && agents?.length === 0 && (
              <EmptyState
                size="compact"
                icon={RobotIcon}
                title="No automations yet"
                description="Schedule recurring work or prepare an event-triggered automation."
                action={
                  <CreateAgentMenu onCreate={createAgent} disabled={createDisabled} outline />
                }
              />
            )}
            {(!!agents?.length || continuation) &&
              (['scheduled', 'event'] as const).map((kind) => (
                <section
                  key={kind}
                  aria-label={kind === 'scheduled' ? 'Scheduled' : 'Event-triggered'}
                  className="mb-3"
                >
                  <h2 className="px-3 py-2 text-xs font-semibold text-muted-foreground">
                    {kind === 'scheduled' ? 'Scheduled' : 'Event-triggered'}
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
        <main
          ref={editorRef}
          tabIndex={-1}
          aria-label="Automation details"
          className="min-h-0 min-w-0 flex-none overflow-visible @[48rem]/agents:flex-1 @[48rem]/agents:overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-4xl space-y-7 p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
