import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withNativeRpc } from './native-rpc';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cleanup: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/backend/lib/owned-codex-command', () => ({
  getOwnedCodexCommand: () => ({ command: 'owned-native', args: ['app-server'] }),
}));
vi.mock('@/backend/lib/owned-process-cleanup', () => ({
  terminateDisposableProcessTree: mocks.cleanup,
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
  expect(mocks.cleanup).toHaveBeenCalledWith(child);
  expect(child.stdout.destroyed).toBe(true);
});
it('sanitizes native process errors and cleans up cancellation', async () => {
  const controller = new AbortController();
  respond = false;
  const result = withNativeRpc(context, (rpc) => rpc.request('account/read'), {
    signal: controller.signal,
  });
  const rejected = expect(result).rejects.toThrow('Codex native account operation failed');
  child.stderr.write('private credential');
  controller.abort();
  await rejected;
  expect(mocks.cleanup).toHaveBeenCalledWith(child);
  expect(child.stderr.destroyed).toBe(true);
});
it('bounds stalled native operations and never returns native error text', async () => {
  respond = false;
  const result = withNativeRpc(context, (rpc) => rpc.request('account/read'), { timeoutMs: 10 });
  await expect(result).rejects.toThrow('Codex native account operation failed');
  expect(mocks.cleanup).toHaveBeenCalledWith(child);
});
