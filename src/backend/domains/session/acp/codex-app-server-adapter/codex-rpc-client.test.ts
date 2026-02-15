import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { CodexRequestError, CodexRpcClient } from './codex-rpc-client';

type MockChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM') {
      child.exitCode = 0;
      child.emit('exit', 0, 'SIGTERM');
    }
    if (signal === 'SIGKILL') {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    }
    return true;
  });
  return child;
}

describe('CodexRpcClient', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('spawns codex app-server and resolves request responses', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    let stdinWritten = '';
    child.stdin.on('data', (chunk) => {
      stdinWritten += chunk.toString('utf8');
    });

    const client = new CodexRpcClient({
      cwd: '/tmp/workspace',
      env: {},
    });
    client.start();

    const responsePromise = client.request<{ ok: boolean }>('model/list', {});
    await vi.waitFor(() => {
      expect(stdinWritten).toContain('"method":"model/list"');
    });

    child.stdout.write('{"id":1,"result":{"ok":true}}\n');
    await expect(responsePromise).resolves.toEqual({ ok: true });

    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server'], expect.any(Object));
  });

  it('routes notifications, server requests, and protocol errors', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const onNotification = vi.fn();
    const onRequest = vi.fn();
    const onProtocolError = vi.fn();
    const client = new CodexRpcClient({
      cwd: '/tmp/workspace',
      env: {},
      onNotification,
      onRequest,
      onProtocolError,
    });

    client.start();
    child.stdout.write(
      '{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i","delta":"x"}}\n'
    );
    child.stdout.write(
      '{"id":9,"method":"item/fileChange/requestApproval","params":{"threadId":"t","turnId":"u","itemId":"i"}}\n'
    );
    child.stdout.write('{bad-json\n');

    await vi.waitFor(() => {
      expect(onNotification).toHaveBeenCalledTimes(1);
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(onProtocolError).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'invalid_json' })
      );
    });
  });

  it('rejects request with CodexRequestError on JSON-RPC error response', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const client = new CodexRpcClient({
      cwd: '/tmp/workspace',
      env: {},
    });

    client.start();
    const responsePromise = client.request('turn/start', { threadId: 'thread_1' });
    child.stdout.write(
      '{"id":1,"error":{"code":-32001,"message":"Server overloaded; retry later."}}\n'
    );

    await expect(responsePromise).rejects.toBeInstanceOf(CodexRequestError);
    await expect(responsePromise).rejects.toMatchObject({
      code: -32_001,
      message: 'Server overloaded; retry later.',
    });
  });

  it('rejects pending requests when codex process exits', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const client = new CodexRpcClient({
      cwd: '/tmp/workspace',
      env: {},
    });

    client.start();
    const responsePromise = client.request('turn/start', { threadId: 'thread_1' });
    child.emit('exit', 1, null);

    await expect(responsePromise).rejects.toThrow(/codex app-server exited/);
  });

  it('stops the subprocess gracefully', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const client = new CodexRpcClient({
      cwd: '/tmp/workspace',
      env: {},
    });

    client.start();
    await client.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
