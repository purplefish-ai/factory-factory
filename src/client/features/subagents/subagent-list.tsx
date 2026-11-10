import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { SubagentIcon } from '@/client/components/subagent-icon';
import {
  SessionTargetStopButton,
  useReconcileSessionTargetStops,
} from '@/client/features/session-controls';
import { useRememberedDisclosure } from '@/client/hooks/use-remembered-disclosure';
import { getSubagentIconIndices } from '@/client/lib/subagent-icon-indices';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isActiveSubagent } from './subagent-status';
import type { SubagentListItem } from './types';

export type SubagentListState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string; onRetry: () => void }
  | {
      kind: 'ready';
      subagents: SubagentListItem[];
      hasMore?: boolean;
      loadingMore?: boolean;
      onLoadMore?: () => void;
      error?: { message: string; onRetry: () => void };
    };

export interface SubagentListProps {
  sessionId?: string | null;
  state: SubagentListState;
  activeOnly?: boolean;
  selectedSubagentId?: string | null;
  controlSessionId?: string;
  controlRuntimeId?: string;
  onSelect: (subagent: SubagentListItem) => void;
}

function timestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatElapsed(subagent: SubagentListItem): string | null {
  const startedAt = timestamp(subagent.createdAt);
  if (startedAt === null) {
    return null;
  }

  const terminal = !isActiveSubagent(subagent);
  const finishedAt = terminal
    ? (timestamp(subagent.completedAt) ?? timestamp(subagent.updatedAt))
    : Date.now();
  if (finishedAt === null) {
    return null;
  }
  const elapsedSeconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s elapsed`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m elapsed`;
  }

  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  if (hours < 24) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''} elapsed`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours > 0 ? ` ${remainingHours}h` : ''} elapsed`;
}

function displayName(subagent: SubagentListItem): string {
  const providerName = subagent.name?.trim();
  return providerName || `Subagent ${subagent.id.slice(0, 8)}`;
}

function statusLabel(status: SubagentListItem['status']): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function activityPreview(subagent: SubagentListItem): string | null {
  return isActiveSubagent(subagent)
    ? (subagent.latestActivity ?? subagent.resultPreview)
    : (subagent.resultPreview ?? subagent.latestActivity);
}

function SubagentRow({
  subagent,
  iconIndex,
  controlSessionId,
  controlRuntimeId,
  selected,
  onSelect,
}: {
  subagent: SubagentListItem;
  iconIndex: number;
  controlSessionId?: string;
  controlRuntimeId?: string;
  selected: boolean;
  onSelect: (subagent: SubagentListItem) => void;
}) {
  const elapsed = formatElapsed(subagent);
  const preview = activityPreview(subagent);

  return (
    <li className="flex items-start">
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(subagent)}
        className={cn(
          'min-w-0 flex-1 cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-ring focus-visible:ring-inset',
          selected && 'bg-muted'
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <SubagentIcon index={iconIndex} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">{displayName(subagent)}</p>
            <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
              <span>{statusLabel(subagent.status)}</span>
              {subagent.model && (
                <>
                  <span aria-hidden="true">·</span>
                  <span title={`Model: ${subagent.model}`} className="truncate">
                    {subagent.model}
                  </span>
                </>
              )}
              {elapsed && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{elapsed}</span>
                </>
              )}
            </div>
            {preview && (
              <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{preview}</p>
            )}
          </div>
        </div>
      </button>
      {controlSessionId &&
        isActiveSubagent(subagent) &&
        subagent.stopControl &&
        subagent.stopControl.runtimeId === controlRuntimeId && (
          <div className="pr-2 pt-2">
            <SessionTargetStopButton
              key={subagent.stopControl.controlId}
              sessionId={controlSessionId}
              itemLabel={displayName(subagent)}
              target={{
                kind: 'subagent',
                id: subagent.id,
                controlId: subagent.stopControl.controlId,
              }}
            />
          </div>
        )}
    </li>
  );
}

/** A failed next page or refresh while loaded subagents stay listed. */
function ListRefreshError({ error }: { error: { message: string; onRetry: () => void } }) {
  return (
    <QueryRefreshError title="Couldn't load subagents" error={error} onRetry={error.onRetry} />
  );
}

function EmptyReadyState({ state }: { state: Extract<SubagentListState, { kind: 'ready' }> }) {
  return (
    <div>
      {state.error && <ListRefreshError error={state.error} />}
      <EmptyState
        size="compact"
        icon={RobotIcon}
        title="No subagents for this session"
        action={
          state.hasMore && state.onLoadMore && !state.error ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              pending={state.loadingMore}
              pendingLabel="Loading more…"
              onClick={state.onLoadMore}
            >
              Load more
            </Button>
          ) : null
        }
      />
    </div>
  );
}

function compareActive(left: SubagentListItem, right: SubagentListItem): number {
  const leftTime = timestamp(left.createdAt) ?? Number.MAX_SAFE_INTEGER;
  const rightTime = timestamp(right.createdAt) ?? Number.MAX_SAFE_INTEGER;
  return leftTime - rightTime || left.id.localeCompare(right.id);
}

function terminalTimestamp(subagent: SubagentListItem): number {
  return timestamp(subagent.completedAt) ?? timestamp(subagent.updatedAt) ?? 0;
}

function compareTerminal(left: SubagentListItem, right: SubagentListItem): number {
  return terminalTimestamp(right) - terminalTimestamp(left) || left.id.localeCompare(right.id);
}

export function SubagentList({
  sessionId,
  state,
  selectedSubagentId,
  controlSessionId,
  controlRuntimeId,
  onSelect,
  activeOnly = false,
}: SubagentListProps) {
  useReconcileSessionTargetStops(
    state.kind === 'ready' && !state.hasMore && !state.error ? controlSessionId : undefined,
    'subagent',
    state.kind === 'ready'
      ? state.subagents.filter(
          (item) => isActiveSubagent(item) && item.stopControl?.runtimeId === controlRuntimeId
        )
      : []
  );
  const [completedExpanded, setCompletedExpanded] = useRememberedDisclosure(
    sessionId,
    'completed-subagents'
  );
  const [, setElapsedTick] = useState(0);
  const groups = useMemo(() => {
    if (state.kind !== 'ready') {
      return { active: [], terminal: [] };
    }
    return {
      active: state.subagents.filter(isActiveSubagent).sort(compareActive),
      terminal: state.subagents.filter((item) => !isActiveSubagent(item)).sort(compareTerminal),
    };
  }, [state]);

  const iconIndices = useMemo(
    () => getSubagentIconIndices(state.kind === 'ready' ? state.subagents : []),
    [state]
  );

  useEffect(() => {
    if (groups.active.length === 0) {
      return;
    }
    const interval = setInterval(() => setElapsedTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, [groups.active.length]);

  if (state.kind === 'unsupported') {
    return (
      <EmptyState
        size="compact"
        icon={RobotIcon}
        title="Subagents unavailable"
        description="This session’s provider does not currently make subagents available. History may be unavailable after the session stops."
      />
    );
  }

  if (state.kind === 'loading') {
    return <Loading size="compact" message="Loading subagents…" />;
  }

  if (state.kind === 'error') {
    return (
      <QueryErrorState
        title="Couldn't load subagents"
        error={state}
        onRetry={state.onRetry}
        className="p-3"
      />
    );
  }

  if (state.subagents.length === 0) {
    return <EmptyReadyState state={state} />;
  }

  return (
    <div>
      {state.error && <ListRefreshError error={state.error} />}
      {groups.active.length > 0 && (
        <ul className="divide-y divide-border/50">
          {groups.active.map((subagent) => (
            <SubagentRow
              key={subagent.id}
              subagent={subagent}
              controlSessionId={controlSessionId}
              controlRuntimeId={controlRuntimeId}
              iconIndex={iconIndices.get(subagent.id) ?? 0}
              selected={selectedSubagentId === subagent.id}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {!activeOnly && groups.terminal.length > 0 && (
        <div className={cn(groups.active.length > 0 && 'border-t')}>
          <button
            type="button"
            aria-expanded={completedExpanded}
            onClick={() => setCompletedExpanded(!completedExpanded)}
            className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors focus-ring focus-visible:ring-inset hover:bg-muted/50 hover:text-foreground"
          >
            {completedExpanded ? (
              <CaretDownIcon className="h-3.5 w-3.5" />
            ) : (
              <CaretRightIcon className="h-3.5 w-3.5" />
            )}
            <span>Completed · {groups.terminal.length}</span>
          </button>
          {completedExpanded && (
            <ul className="divide-y divide-border/50 border-t border-border/50">
              {groups.terminal.map((subagent) => (
                <SubagentRow
                  key={subagent.id}
                  subagent={subagent}
                  controlSessionId={controlSessionId}
                  controlRuntimeId={controlRuntimeId}
                  iconIndex={iconIndices.get(subagent.id) ?? 0}
                  selected={selectedSubagentId === subagent.id}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {state.hasMore && state.onLoadMore && !state.error && (
        <div className="flex justify-center border-t px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            pending={state.loadingMore}
            pendingLabel="Loading more…"
            onClick={state.onLoadMore}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
