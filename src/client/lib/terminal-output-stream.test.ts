import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_OUTPUT_MAX_CHARS, TERMINAL_TRUNCATION_MARKER } from './rolling-output';
import { TerminalOutputStream } from './terminal-output-stream';

describe('TerminalOutputStream', () => {
  it('retains appended output and notifies subscribers with each chunk', () => {
    const stream = new TerminalOutputStream('$ ');
    const listener = vi.fn();
    stream.subscribe(listener);

    stream.append('ls\r\n');
    stream.append('');

    expect(stream.snapshot()).toBe('$ ls\r\n');
    expect(listener.mock.calls).toEqual([[{ type: 'append', data: 'ls\r\n' }]]);
  });

  it('bounds the snapshot while still delivering chunks past the cap', () => {
    const stream = new TerminalOutputStream('a'.repeat(TERMINAL_OUTPUT_MAX_CHARS));
    const listener = vi.fn();
    stream.subscribe(listener);

    stream.append('b'.repeat(100));

    const snapshot = stream.snapshot();
    expect(snapshot.length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(snapshot.startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(snapshot.endsWith('b'.repeat(100))).toBe(true);
    expect(listener.mock.calls).toEqual([[{ type: 'append', data: 'b'.repeat(100) }]]);
  });

  it('emits only the suffix when a replacement extends the current output', () => {
    const stream = new TerminalOutputStream('before\r\n');
    const listener = vi.fn();
    stream.subscribe(listener);

    stream.replace('before\r\n');
    stream.replace('before\r\nmissed\r\n');

    expect(stream.snapshot()).toBe('before\r\nmissed\r\n');
    expect(listener.mock.calls).toEqual([[{ type: 'append', data: 'missed\r\n' }]]);
  });

  it('emits a reset when a capped window shifts, even if the replacement extends it', () => {
    const full = 'd'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 10);
    const stream = new TerminalOutputStream(full);
    const listener = vi.fn();
    stream.subscribe(listener);

    stream.replace(`${full}more`);

    expect(listener.mock.calls).toEqual([[{ type: 'reset', output: stream.snapshot() }]]);
    expect(stream.snapshot().endsWith('more')).toBe(true);
    expect(stream.snapshot().length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
  });

  it('emits a bounded reset when a replacement does not extend the current output', () => {
    const stream = new TerminalOutputStream('local');
    const listener = vi.fn();
    stream.subscribe(listener);

    stream.replace('c'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 10));
    stream.replace('');

    const reset = listener.mock.calls[0]?.[0] as { type: string; output: string };
    expect(reset.type).toBe('reset');
    expect(reset.output.length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(reset.output.startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(listener.mock.calls[1]).toEqual([{ type: 'reset', output: '' }]);
    expect(stream.snapshot()).toBe('');
  });

  it('stops notifying after unsubscribe', () => {
    const stream = new TerminalOutputStream();
    const listener = vi.fn();
    const unsubscribe = stream.subscribe(listener);

    unsubscribe();
    stream.append('ignored');

    expect(listener).not.toHaveBeenCalled();
    expect(stream.snapshot()).toBe('ignored');
  });
});
