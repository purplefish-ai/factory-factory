import { describe, expect, it, vi } from 'vitest';
import { RunScriptOutputBuffer } from './run-script-output-buffer';

describe('RunScriptOutputBuffer', () => {
  it('clears a workspace buffer without dropping listeners', () => {
    const buffer = new RunScriptOutputBuffer(1024);
    const listener = vi.fn();
    buffer.set('ws-1', 'old logs');
    buffer.subscribe('ws-1', listener);

    buffer.clearBuffer('ws-1');
    buffer.append('ws-1', 'new logs');

    expect(buffer.get('ws-1')).toBe('new logs');
    expect(listener).toHaveBeenCalledWith('new logs');
  });

  it('evicts a workspace buffer and its listeners', () => {
    const buffer = new RunScriptOutputBuffer(1024);
    const listener = vi.fn();
    buffer.set('ws-1', 'old logs');
    buffer.subscribe('ws-1', listener);

    buffer.evict('ws-1');
    buffer.append('ws-1', 'new logs');

    expect(buffer.get('ws-1')).toBe('new logs');
    expect(listener).not.toHaveBeenCalled();
  });
});
