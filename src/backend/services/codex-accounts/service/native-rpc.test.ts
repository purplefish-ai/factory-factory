import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withNativeRpc } from './native-rpc';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cleanup: vi.fn(), warn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/backend/lib/owned-codex-command', () => ({
  getOwnedCodexCommand: () => ({ command: 'owned-native', args: ['app-server'] }),
}));
vi.mock('@/backend/lib/owned-process-cleanup', () => ({
  terminateDisposableProcessTree: mocks.cleanup,
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
const requestSchema = z.object({ id: z.number().optional(), method: z.string() });
const context = {
  accountId: 'managed-one',
  homeDir: '/one',
  sessionsDir: '/one/sessions',
  env: { CODEX_HOME: '/one' },
};
let child: ReturnType<typeof makeChild>;
let respond: boolean;
function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  respond = true;
  child = makeChild();
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.spawn.mockReturnValue(child);
  child.stdin.on('data', (buffer: Buffer) => {
    const request = requestSchema.parse(JSON.parse(buffer.toString()));
    if (request.id !== undefined && respond) {
      queueMicrotask(() =>
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`)
      );
    }
  });
});
it('passes the exact profile environment and always cleans up the owned native process', async () => {
  expect(await withNativeRpc(context, (rpc) => rpc.request('account/read'))).toEqual({ ok: true });
  expect(mocks.spawn.mock.calls[0]?.[2].env.CODEX_HOME).toBe('/one');
  expect(mocks.cleanup).toHaveBeenCalledWith(child, { timeoutMs: expect.any(Number) });
  expect(child.stdout.destroyed).toBe(true);
});
it('sanitizes native process errors and cleans up cancellation', async () => {
  const controller = new AbortController();
  respond = false;
  const result = withNativeRpc(context, (rpc) => rpc.request('account/read'), {
    signal: controller.signal,
  });
  const rejected = expect(result).rejects.toThrow('Codex native account operation failed');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(child.stderr.listenerCount('error')).toBeGreaterThan(0);
  child.stderr.write('private credential');
  controller.abort();
  await rejected;
  expect(mocks.cleanup).toHaveBeenCalledWith(child, { timeoutMs: expect.any(Number) });
  expect(child.stderr.destroyed).toBe(true);
});
it('bounds stalled native operations and never returns native error text', async () => {
  respond = false;
  const result = withNativeRpc(context, (rpc) => rpc.request('account/read'), { timeoutMs: 10 });
  await expect(result).rejects.toThrow('Codex native account operation failed');
  expect(mocks.cleanup).toHaveBeenCalledWith(child, { timeoutMs: expect.any(Number) });
});

it('includes slow cleanup within the configured operation deadline', async () => {
  vi.useFakeTimers();
  try {
    respond = false;
    mocks.cleanup.mockImplementation(
      (_child, options?: { timeoutMs: number }) =>
        new Promise((resolve) => setTimeout(resolve, options?.timeoutMs ?? 5000))
    );
    const result = withNativeRpc(context, (rpc) => rpc.request('account/read'), { timeoutMs: 100 });
    const rejected = expect(result).rejects.toThrow('Codex native account operation failed');
    await vi.advanceTimersByTimeAsync(100);
    expect(child.stderr.destroyed).toBe(true);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a successful result when owned cleanup fails and logs the failure', async () => {
  mocks.cleanup.mockRejectedValue(new Error('Disposable process cleanup failed'));
  expect(await withNativeRpc(context, (rpc) => rpc.request('account/read'))).toEqual({ ok: true });
  expect(mocks.warn).toHaveBeenCalledWith('Codex native process cleanup failed', {
    accountId: 'managed-one',
    error: 'Disposable process cleanup failed',
  });
  expect(child.stderr.destroyed).toBe(true);
});

it('reports the operation failure instead of a later cleanup failure', async () => {
  respond = false;
  mocks.cleanup.mockRejectedValue(new Error('Disposable process cleanup failed'));
  await expect(
    withNativeRpc(context, (rpc) => rpc.request('account/read'), { timeoutMs: 10 })
  ).rejects.toThrow('Codex native account operation failed');
  expect(child.stderr.destroyed).toBe(true);
});
