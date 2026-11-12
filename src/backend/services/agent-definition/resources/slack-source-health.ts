import type { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentSourceCursorSchema, agentSourceHealthSchema } from '@/shared/agent-runtime';

type SlackCursor = Extract<z.infer<typeof agentSourceCursorSchema>, { provider: 'SLACK' }>;
type Gap = SlackCursor['gaps'][number];
type Health = z.infer<typeof agentSourceHealthSchema>;
type SourceRow = { health: unknown; cursor: unknown; lastObservedAt: Date | null } | null;
/** A Slack source row to write; null leaves the row as it is. */
export type SlackSourceWrite = {
  cursor: SlackCursor;
  health: Health;
  isReady: boolean;
  lastObservedAt?: Date;
} | null;
const MAX_GAPS = 100;

/**
 * A listener that should be connected but is not. `interrupted` opens a
 * delivery gap; a deliberate stop of listening (gate off, no listening
 * trigger, no app-level token) closes any open gap instead.
 */
export type SlackSourceUnavailable = {
  state: 'DISCONNECTED' | 'ERROR';
  reasonCode: string;
  interrupted: boolean;
};

function read(row: SourceRow) {
  const health = row?.health == null ? null : agentSourceHealthSchema.parse(row.health);
  let cursor: SlackCursor = { version: 1, provider: 'SLACK', gaps: [] };
  if (row?.cursor != null) {
    const parsed = agentSourceCursorSchema.parse(row.cursor);
    if (parsed.provider !== 'SLACK') {
      throw new ApplicationError(
        'INVALID_INPUT',
        'The stored source cursor is not a Slack cursor.'
      );
    }
    cursor = parsed;
  }
  return { health, cursor };
}

function openGap(gaps: Gap[]) {
  const last = gaps.at(-1);
  return last && last.to === null ? last : null;
}

function withGap(gaps: Gap[], from: Date) {
  return [...gaps, { from: from.toISOString(), to: null }].slice(-MAX_GAPS);
}

function closeGap(gaps: Gap[], at: Date) {
  const open = openGap(gaps);
  return open ? [...gaps.slice(0, -1), { from: open.from, to: at.toISOString() }] : gaps;
}

function health(state: Health['state'], reasonCode: string | null) {
  return agentSourceHealthSchema.parse({ state, reasonCode, updatedAt: new Date().toISOString() });
}

/** The socket's `hello` matched the stored app. Closes any open gap at `at`. */
export function slackReady(row: SourceRow, at: Date): SlackSourceWrite {
  const current = read(row);
  if (current.health?.state === 'RECOVERY_REQUIRED') {
    return null;
  }
  return {
    cursor: { ...current.cursor, gaps: closeGap(current.cursor.gaps, at) },
    health: current.health?.state === 'READY' ? current.health : health('READY', null),
    isReady: true,
    lastObservedAt: at,
  };
}

export function slackUnavailable(
  row: SourceRow,
  change: SlackSourceUnavailable,
  at: Date
): SlackSourceWrite {
  const current = read(row);
  if (current.health?.state === 'RECOVERY_REQUIRED') {
    return null;
  }
  const open = openGap(current.cursor.gaps);
  let gaps = current.cursor.gaps;
  if (change.interrupted && !open) {
    gaps = withGap(gaps, at);
  } else if (!change.interrupted && open) {
    gaps = closeGap(gaps, at);
  }
  if (
    row !== null &&
    current.health?.state === change.state &&
    current.health.reasonCode === change.reasonCode &&
    gaps === current.cursor.gaps
  ) {
    return null;
  }
  return {
    cursor: { ...current.cursor, gaps },
    health: health(change.state, change.reasonCode),
    isReady: false,
  };
}

/**
 * A process that exited without recording its disconnect leaves READY behind.
 * Open a gap from the last time that listener was known to be connected.
 */
export function slackUncleanExit(row: SourceRow, at: Date): SlackSourceWrite {
  const current = read(row);
  if (current.health?.state !== 'READY') {
    return null;
  }
  const gaps = openGap(current.cursor.gaps)
    ? current.cursor.gaps
    : withGap(current.cursor.gaps, row?.lastObservedAt ?? at);
  return {
    cursor: { ...current.cursor, gaps },
    health: health('DISCONNECTED', 'SLACK_LISTENER_STOPPED'),
    isReady: false,
  };
}
