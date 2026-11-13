import './run-script-legacy.test-support';
import { describe, expect, it, vi } from 'vitest';
import { createOutputWriters } from './run-script-legacy.test-support';
import { RunScriptService } from './run-script.service';

describe('RunScriptService main output', () => {
  it('truncates output buffer when exceeding MAX_OUTPUT_BUFFER_SIZE', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');

    // Build a string just over 500KB
    const bigChunk = 'x'.repeat(400 * 1024);
    writers.main(bigChunk);

    const smallChunk = 'y'.repeat(200 * 1024);
    writers.main(smallChunk);

    const buffer = service.getOutputBuffer('ws-1');
    // Buffer should be capped at 500KB
    expect(buffer.length).toBe(500 * 1024);
    // Should contain the latest data
    expect(buffer.endsWith('y'.repeat(200 * 1024))).toBe(true);
  });

  it('notifies listeners on new output', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    const listener = vi.fn();
    service.subscribeToOutput('ws-1', listener);

    writers.main('hello');
    expect(listener).toHaveBeenCalledWith('hello');
  });

  it('returns empty string for unknown workspace', () => {
    const service = new RunScriptService();
    expect(service.getOutputBuffer('unknown')).toBe('');
  });
});

describe('RunScriptService.subscribeToOutput', () => {
  it('returns unsubscribe function that stops notifications', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    const listener = vi.fn();
    const unsub = service.subscribeToOutput('ws-1', listener);

    writers.main('before');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    writers.main('after');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('allows resubscribe after the last listener unsubscribes', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const unsub = service.subscribeToOutput('ws-1', firstListener);
    writers.main('first');

    unsub();
    service.subscribeToOutput('ws-1', secondListener);
    writers.main('second');

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledWith('second');
  });
});

describe('RunScriptService.evictWorkspaceBuffers', () => {
  it('evicts output and listener buffers for an archived workspace only', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    const secondWriters = await createOutputWriters(service, 'ws-2');
    const workspaceOneOutputListener = vi.fn();
    const workspaceOnePostRunListener = vi.fn();
    const workspaceTwoOutputListener = vi.fn();
    const workspaceTwoPostRunListener = vi.fn();

    service.subscribeToOutput('ws-1', workspaceOneOutputListener);
    service.subscribeToPostRunOutput('ws-1', workspaceOnePostRunListener);
    service.subscribeToOutput('ws-2', workspaceTwoOutputListener);
    service.subscribeToPostRunOutput('ws-2', workspaceTwoPostRunListener);
    writers.main('main logs');
    writers.postRun('postRun logs');
    secondWriters.main('keep');
    secondWriters.postRun('postRun keep');

    service.evictWorkspaceBuffers('ws-1');

    expect(service.getOutputBuffer('ws-1')).toBe('');
    expect(service.getPostRunOutputBuffer('ws-1')).toBe('');
    expect(service.getOutputBuffer('ws-2')).toContain('keep');
    expect(service.getPostRunOutputBuffer('ws-2')).toContain('postRun keep');

    writers.main('after eviction');
    writers.postRun('postRun after eviction');
    secondWriters.main(' still subscribed');
    secondWriters.postRun(' still subscribed');

    expect(workspaceOneOutputListener).toHaveBeenCalledTimes(1);
    expect(workspaceOnePostRunListener).toHaveBeenCalledTimes(1);
    expect(workspaceTwoOutputListener).toHaveBeenLastCalledWith(' still subscribed');
    expect(workspaceTwoPostRunListener).toHaveBeenLastCalledWith(' still subscribed');
  });
});

describe('RunScriptService postRun output', () => {
  it('appends postRun output and notifies postRun listeners', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    const listener = vi.fn();
    const unsubscribe = service.subscribeToPostRunOutput('ws-1', listener);

    writers.postRun('hello');
    expect(listener).toHaveBeenCalledWith('hello');
    expect(service.getPostRunOutputBuffer('ws-1')).toContain('hello');

    unsubscribe();
    writers.postRun('again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('truncates oversized postRun buffers and returns empty for unknown workspaces', async () => {
    const service = new RunScriptService();
    const writers = await createOutputWriters(service, 'ws-1');
    writers.postRun('x'.repeat(450 * 1024));
    writers.postRun('y'.repeat(200 * 1024));

    const buffer = service.getPostRunOutputBuffer('ws-1');
    expect(buffer.length).toBe(500 * 1024);
    expect(buffer.endsWith('y'.repeat(200 * 1024))).toBe(true);
    expect(service.getPostRunOutputBuffer('unknown')).toBe('');
  });
});
