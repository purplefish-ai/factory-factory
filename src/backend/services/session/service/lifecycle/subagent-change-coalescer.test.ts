import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentChangeCoalescer } from './subagent-change-coalescer';

describe('SubagentChangeCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits at most one update per subagent per interval', () => {
    const emit = vi.fn();
    const coalescer = new SubagentChangeCoalescer(emit, 250);

    for (let i = 0; i < 50; i++) {
      coalescer.push('session-1', 'child-1', 'updated');
    }
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('session-1', 'child-1', 'updated');

    coalescer.push('session-1', 'child-1', 'updated');
    vi.advanceTimersByTime(250);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('tracks subagents and sessions independently', () => {
    const emit = vi.fn();
    const coalescer = new SubagentChangeCoalescer(emit, 250);

    coalescer.push('session-1', 'child-1', 'updated');
    coalescer.push('session-1', 'child-2', 'updated');
    coalescer.push('session-2', 'child-1', 'updated');
    vi.advanceTimersByTime(250);

    expect(emit.mock.calls).toEqual([
      ['session-1', 'child-1', 'updated'],
      ['session-1', 'child-2', 'updated'],
      ['session-2', 'child-1', 'updated'],
    ]);
  });

  it('emits lifecycle changes immediately and drops the superseded pending update', () => {
    const emit = vi.fn();
    const coalescer = new SubagentChangeCoalescer(emit, 250);

    coalescer.push('session-1', 'child-1', 'created');
    coalescer.push('session-1', 'child-1', 'updated');
    coalescer.push('session-1', 'child-1', 'completed');
    vi.advanceTimersByTime(1000);

    expect(emit.mock.calls).toEqual([
      ['session-1', 'child-1', 'created'],
      ['session-1', 'child-1', 'completed'],
    ]);
  });

  it('flushes pending updates for one session without waiting', () => {
    const emit = vi.fn();
    const coalescer = new SubagentChangeCoalescer(emit, 250);

    coalescer.push('session-1', 'child-1', 'updated');
    coalescer.push('session-2', 'child-1', 'updated');
    coalescer.flushSession('session-1');

    expect(emit.mock.calls).toEqual([['session-1', 'child-1', 'updated']]);
    vi.advanceTimersByTime(250);
    expect(emit.mock.calls).toEqual([
      ['session-1', 'child-1', 'updated'],
      ['session-2', 'child-1', 'updated'],
    ]);
  });
});
