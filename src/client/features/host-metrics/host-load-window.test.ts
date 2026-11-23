import { describe, expect, it } from 'vitest';
import { hostLoadCursor, mergeHostLoadHistory } from './host-load-window';

const sample = (at: number, cpuPercent = 10) => ({ at, cpuPercent, memoryPercent: 30 });
/** Samples five seconds apart starting at `from`. */
const run = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => sample(from + index * 5000));
const times = (samples: readonly { at: number }[]) => samples.map((entry) => entry.at);

describe('mergeHostLoadHistory', () => {
  it('takes the whole window on the first poll', () => {
    const window = run(0, 3);

    expect(mergeHostLoadHistory(undefined, { samples: window, since: null, oldestAt: 0 })).toEqual(
      window
    );
  });

  it('appends the samples taken after the cursor', () => {
    const held = run(0, 3);

    const merged = mergeHostLoadHistory(held, {
      samples: [sample(15_000, 55)],
      since: 10_000,
      oldestAt: 0,
    });

    expect(times(merged)).toEqual([0, 5000, 10_000, 15_000]);
    expect(merged.at(-1)).toEqual(sample(15_000, 55));
  });

  it('keeps the window as it is when nothing is new', () => {
    const held = run(0, 3);

    expect(mergeHostLoadHistory(held, { samples: [], since: 10_000, oldestAt: 0 })).toEqual(held);
  });

  it('keeps one sample per time, preferring the server copy', () => {
    const held = run(0, 3);

    const merged = mergeHostLoadHistory(held, {
      samples: [sample(10_000, 80), sample(15_000)],
      since: 5000,
      oldestAt: 0,
    });

    expect(times(merged)).toEqual([0, 5000, 10_000, 15_000]);
    expect(merged[2]?.cpuPercent).toBe(80);
  });

  it('orders samples oldest first whatever order they arrive in', () => {
    const merged = mergeHostLoadHistory(run(0, 2), {
      samples: [sample(15_000), sample(10_000)],
      since: 5000,
      oldestAt: 0,
    });

    expect(times(merged)).toEqual([0, 5000, 10_000, 15_000]);
  });

  it('drops what the server has dropped, so the window stays capped', () => {
    const held = run(0, 60);

    const merged = mergeHostLoadHistory(held, {
      samples: [sample(300_000)],
      since: 295_000,
      oldestAt: 5000,
    });

    expect(merged).toHaveLength(60);
    expect(merged[0]?.at).toBe(5000);
    expect(merged.at(-1)?.at).toBe(300_000);
  });

  it('catches up after a pause while other readers kept the window going', () => {
    const held = run(0, 60);
    // Hidden for two minutes: 24 new samples, the oldest 24 rolled out.
    const missed = run(300_000, 24);

    const merged = mergeHostLoadHistory(held, {
      samples: missed,
      since: 295_000,
      oldestAt: 120_000,
    });

    expect(merged).toHaveLength(60);
    expect(times(merged)).toEqual(times(run(120_000, 60)));
  });

  it('replaces the window after a pause long enough for the server to start over', () => {
    const fresh = [sample(900_000)];

    const merged = mergeHostLoadHistory(run(0, 60), {
      samples: fresh,
      since: null,
      oldestAt: 900_000,
    });

    expect(merged).toEqual(fresh);
  });

  it('replaces the window after a server restart, even with earlier timestamps', () => {
    // A restarted server's clock may read earlier than the newest held sample.
    const fresh = run(100_000, 2);

    const merged = mergeHostLoadHistory(run(200_000, 10), {
      samples: fresh,
      since: null,
      oldestAt: 100_000,
    });

    expect(merged).toEqual(fresh);
  });
});

describe('hostLoadCursor', () => {
  it('asks for everything until a window is held', () => {
    expect(hostLoadCursor(undefined)).toBeUndefined();
    expect(hostLoadCursor([])).toBeUndefined();
  });

  it('asks for what came after the newest sample held', () => {
    expect(hostLoadCursor(run(0, 3))).toEqual({ after: 10_000 });
  });
});
