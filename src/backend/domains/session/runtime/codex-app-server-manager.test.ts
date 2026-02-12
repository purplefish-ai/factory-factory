import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CodexAppServerManager } from './codex-app-server-manager';

class CaptureWritable extends Writable {
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    this.chunks.push(chunk.toString());
    callback();
  }

  getLines(): string[] {
    return this.chunks
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new CaptureWritable();

  kill(_signal?: NodeJS.Signals): boolean {
    this.emit('exit', 0, null);
    return true;
  }
}

const RpcLineSchema = z
  .object({
    id: z.number().optional(),
    method: z.string().optional(),
  })
  .passthrough();

function parseRpcLine(line: string): z.infer<typeof RpcLineSchema> {
  return RpcLineSchema.parse(JSON.parse(line));
}

function respondToInitialize(fake: FakeChildProcess): void {
  const initLine = fake.stdin
    .getLines()
    .map((line) => parseRpcLine(line))
    .find((line) => line.method === 'initialize');

  if (!initLine?.id) {
    throw new Error('initialize request not found in fake stdin');
  }

  fake.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: initLine.id, result: { ok: true } })}\n`
  );
}

describe('CodexAppServerManager', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.restoreAllMocks();
  });

  it('performs initialize/initialized handshake and reports ready status', async () => {
    const fake = new FakeChildProcess();
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
    });

    const started = manager.ensureStarted();

    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });

    respondToInitialize(fake);
    await started;

    const lines = fake.stdin.getLines().map((line) => parseRpcLine(line));

    expect(lines.some((line) => line.method === 'initialized')).toBe(true);
    expect(manager.getStatus().state).toBe('ready');
  });

  it('fails fast when OPENAI_API_KEY is missing', async () => {
    process.env.OPENAI_API_KEY = '';
    const manager = new CodexAppServerManager();

    await expect(manager.ensureStarted()).rejects.toThrow('missing_api_key');
    expect(manager.getStatus()).toMatchObject({
      state: 'unavailable',
      unavailableReason: 'missing_api_key',
    });
  });

  it('routes notifications by threadId with strict isolation', async () => {
    const fake = new FakeChildProcess();
    const onNotification = vi.fn();

    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
      handlers: {
        onNotification,
      },
    });

    const started = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    await manager.getRegistry().setMappedThreadId('session-1', 'thread-1');

    fake.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      })}\n`
    );

    await vi.waitFor(() => {
      expect(onNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          threadId: 'thread-1',
          method: 'turn/updated',
        })
      );
    });

    onNotification.mockClear();
    fake.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/updated',
        params: { threadId: 'unknown-thread', turnId: 'turn-2' },
      })}\n`
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onNotification).not.toHaveBeenCalled();
  });

  it('tracks interactive server requests via registry with canonical request ids', async () => {
    const fake = new FakeChildProcess();
    const onServerRequest = vi.fn();

    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
      handlers: {
        onServerRequest,
      },
    });

    const started = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    await manager.getRegistry().setMappedThreadId('session-1', 'thread-1');

    fake.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          requestId: 'approval-123',
          command: 'rm -rf /tmp/test',
        },
      })}\n`
    );

    await vi.waitFor(() => {
      expect(onServerRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          requestId: 77,
          method: 'item/commandExecution/requestApproval',
        })
      );
    });

    expect(manager.getRegistry().getPendingInteractiveRequest('session-1', 'approval-123')).toEqual(
      expect.objectContaining({
        serverRequestId: 77,
      })
    );
  });

  it('times out requests and returns retryable error classification', async () => {
    const fake = new FakeChildProcess();
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
    });

    const started = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    await expect(
      manager.request('thread/read', { threadId: 't1' }, { timeoutMs: 5, threadId: 't1' })
    ).rejects.toMatchObject({
      code: 'CODEX_REQUEST_TIMEOUT',
      retryable: true,
    });
  });

  it('fails fast when request write cannot be performed after startup', async () => {
    const fake = new FakeChildProcess();
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
    });

    const started = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    fake.stdin.destroy();

    await expect(
      manager.request('thread/read', { threadId: 'thread-1' }, { threadId: 'thread-1' })
    ).rejects.toMatchObject({
      code: 'CODEX_MANAGER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('fails in-flight requests when process exits and marks manager degraded', async () => {
    const fake = new FakeChildProcess();
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi.fn(() => fake),
      },
    });

    const started = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    const pending = manager.request(
      'thread/read',
      { threadId: 'thread-1' },
      { threadId: 'thread-1' }
    );

    fake.emit('exit', 1, 'SIGKILL');

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_MANAGER_UNAVAILABLE',
      retryable: true,
    });
    expect(manager.getStatus()).toMatchObject({
      state: 'degraded',
      unavailableReason: 'process_exited',
    });
  });

  it('acts as a singleton status source across callers via exported instance semantics', async () => {
    const fake = new FakeChildProcess();
    const processFactory = {
      spawn: vi.fn(() => fake),
    };

    const managerA = new CodexAppServerManager({ processFactory });
    const managerB = managerA;

    const started = managerA.ensureStarted();
    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fake);
    await started;

    expect(managerB.getStatus().state).toBe('ready');
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
  });
});
