import { CaretDownIcon, CaretRightIcon, RobotIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SubagentListItem } from './types';

const ACTIVE_STATUSES = new Set<SubagentListItem['status']>(['starting', 'running', 'waiting']);

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
  state: SubagentListState;
  selectedSubagentId?: string | null;
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

  const terminal = !ACTIVE_STATUSES.has(subagent.status);
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
  return providerName || `Sub-agent ${subagent.id.slice(0, 8)}`;
}

function statusLabel(status: SubagentListItem['status']): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function statusDotClass(status: SubagentListItem['status']): string {
  switch (status) {
    case 'starting':
      return 'bg-yellow-500 animate-pulse';
    case 'running':
      return 'bg-blue-500 animate-pulse';
    case 'waiting':
      return 'bg-amber-500';
    case 'completed':
      return 'bg-green-500';
    case 'failed':
      return 'bg-red-500';
    case 'cancelled':
    case 'interrupted':
      return 'bg-muted-foreground';
  }
}

function activityPreview(subagent: SubagentListItem): string | null {
  return ACTIVE_STATUSES.has(subagent.status)
    ? (subagent.latestActivity ?? subagent.resultPreview)
    : (subagent.resultPreview ?? subagent.latestActivity);
}

function SubagentRow({
  subagent,
  selected,
  onSelect,
}: {
  subagent: SubagentListItem;
  selected: boolean;
  onSelect: (subagent: SubagentListItem) => void;
}) {
  const elapsed = formatElapsed(subagent);
  const preview = activityPreview(subagent);

  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(subagent)}
        className={cn(
          'w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
          selected && 'bg-muted'
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', statusDotClass(subagent.status))}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">{displayName(subagent)}</p>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{statusLabel(subagent.status)}</span>
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
    </li>
  );
}

function PaginationError({ error }: { error: { message: string; onRetry: () => void } }) {
  return (
    <div className="mx-3 my-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-2">
          <p className="break-words text-xs text-destructive">{error.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={error.onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyReadyState({ state }: { state: Extract<SubagentListState, { kind: 'ready' }> }) {
  return (
    <div>
      {state.error && <PaginationError error={state.error} />}
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
        <div className="flex flex-col items-center gap-2">
          <RobotIcon className="h-7 w-7 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No sub-agents for this session.</p>
        </div>
        {state.hasMore && state.onLoadMore && !state.error && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state.loadingMore}
            onClick={state.onLoadMore}
          >
            {state.loadingMore ? 'Loading more…' : 'Load more'}
          </Button>
        )}
      </div>
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

export function SubagentList({ state, selectedSubagentId, onSelect }: SubagentListProps) {
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [, setElapsedTick] = useState(0);
  const groups = useMemo(() => {
    if (state.kind !== 'ready') {
      return { active: [], terminal: [] };
    }
    return {
      active: state.subagents
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .sort(compareActive),
      terminal: state.subagents
        .filter((item) => !ACTIVE_STATUSES.has(item.status))
        .sort(compareTerminal),
    };
  }, [state]);

  useEffect(() => {
    if (groups.active.length === 0) {
      return;
    }
    const interval = setInterval(() => setElapsedTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, [groups.active.length]);

  if (state.kind === 'unsupported') {
    return null;
  }

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
        Loading sub-agents…
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="mx-3 my-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-2">
            <p className="break-words text-xs text-destructive">{state.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={state.onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state.subagents.length === 0) {
    return <EmptyReadyState state={state} />;
  }

  return (
    <div>
      {state.error && <PaginationError error={state.error} />}
      {groups.active.length > 0 && (
        <ul className="divide-y divide-border/50">
          {groups.active.map((subagent) => (
            <SubagentRow
              key={subagent.id}
              subagent={subagent}
              selected={selectedSubagentId === subagent.id}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {groups.terminal.length > 0 && (
        <div className={cn(groups.active.length > 0 && 'border-t')}>
          <button
            type="button"
            aria-expanded={completedExpanded}
            onClick={() => setCompletedExpanded((expanded) => !expanded)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
            disabled={state.loadingMore}
            onClick={state.onLoadMore}
          >
            {state.loadingMore ? 'Loading more…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
