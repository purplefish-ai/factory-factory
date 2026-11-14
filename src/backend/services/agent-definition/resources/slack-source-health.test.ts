import { describe, expect, it } from 'vitest';
import { slackReady, slackUncleanExit, slackUnavailable } from './slack-source-health';

type Row = Parameters<typeof slackReady>[0];
const start = Date.parse('2026-11-14T00:00:00.000Z');
const dropped = {
  state: 'DISCONNECTED',
  reasonCode: 'SLACK_DISCONNECTED',
  interrupted: true,
} as const;

function apply(row: Row, write: ReturnType<typeof slackReady>): Row {
  return write ? { health: write.health, cursor: write.cursor, lastObservedAt: null } : row;
}

describe('Slack source health', () => {
  it('keeps only the latest 100 delivery gaps', () => {
    let row: Row = null;
    for (let index = 0; index < 101; index++) {
      row = apply(row, slackUnavailable(row, dropped, new Date(start + index * 2000)));
      row = apply(row, slackReady(row, new Date(start + index * 2000 + 1000)));
    }
    const gaps = slackUnavailable(row, dropped, new Date(start + 300_000))?.cursor.gaps ?? [];
    expect(gaps).toHaveLength(100);
    expect(gaps[0]?.from).toBe(new Date(start + 4000).toISOString());
    expect(gaps.at(-1)).toEqual({ from: new Date(start + 300_000).toISOString(), to: null });
  });

  it('never overwrites RECOVERY_REQUIRED', () => {
    const row: Row = {
      health: {
        state: 'RECOVERY_REQUIRED',
        reasonCode: 'SOURCE_GAP',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
      cursor: { version: 1, provider: 'SLACK', gaps: [] },
      lastObservedAt: null,
    };
    const at = new Date(start);
    expect(slackReady(row, at)).toBeNull();
    expect(slackUnavailable(row, dropped, at)).toBeNull();
    expect(slackUncleanExit(row, at)).toBeNull();
  });
});
