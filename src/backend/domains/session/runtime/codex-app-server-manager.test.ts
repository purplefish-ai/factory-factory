import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new CaptureWritable();
  killSignals: Array<NodeJS.Signals | undefined> = [];

  constructor(
    private readonly options?: {
      pid?: number;
      emitExitOnKill?: boolean;
    }
  ) {
    super();
    this.pid = options?.pid ?? 4242;
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.killSignals.push(_signal);
    if (this.options?.emitExitOnKill !== false) {
      this.emit('exit', 0, null);
    }
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

function findRpcLineById(
  fake: FakeChildProcess,
  id: number
): z.infer<typeof RpcLineSchema> | undefined {
  return fake.stdin
    .getLines()
    .map((line) => parseRpcLine(line))
    .find((line) => line.id === id);
}

function respondToInitialize(fake: FakeChildProcess): void {
  const initLine = fake.stdin
    .getLines()
    .map((line) => parseRpcLine(line))
    .find((line) => line.method === 'initialize');

  if (!initLine?.id) {
    throw new Error('initialize request not found in fake stdin');
  }

  fake.stdout.write(`${JSON.stringify({ id: initLine.id, result: { ok: true } })}\n`);
}

describe('CodexAppServerManager', () => {
  beforeEach(() => {
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

  it('accepts string server request ids and preserves them for responses', async () => {
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
        id: 'req-77',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          itemId: 'item-123',
        },
      })}\n`
    );

    await vi.waitFor(() => {
      expect(onServerRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          requestId: 'req-77',
          canonicalRequestId: 'item-123',
        })
      );
    });

    expect(manager.getRegistry().getPendingInteractiveRequest('session-1', 'item-123')).toEqual(
      expect.objectContaining({
        serverRequestId: 'req-77',
      })
    );
  });

  it('derives canonical request id from nested params.item.id', async () => {
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
        id: 90,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          item: {
            id: 'nested-item-id',
          },
        },
      })}\n`
    );

    await vi.waitFor(() => {
      expect(onServerRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          canonicalRequestId: 'nested-item-id',
        })
      );
    });

    expect(
      manager.getRegistry().getPendingInteractiveRequest('session-1', 'nested-item-id')
    ).toEqual(
      expect.objectContaining({
        serverRequestId: 90,
      })
    );
  });

  it('responds with JSON-RPC error when server request is missing threadId', async () => {
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

    fake.stdout.write(
      `${JSON.stringify({
        id: 88,
        method: 'item/commandExecution/requestApproval',
        params: {
          requestId: 'approval-1',
        },
      })}\n`
    );

    await vi.waitFor(() => {
      const response = findRpcLineById(fake, 88);
      expect(response).toBeDefined();
      expect(response).toMatchObject({
        id: 88,
        error: expect.objectContaining({
          code: -32_602,
          message: 'Codex server request missing threadId',
        }),
      });
    });
    expect(onServerRequest).not.toHaveBeenCalled();
  });

  it('responds with JSON-RPC error when server request thread is not mapped', async () => {
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

    fake.stdout.write(
      `${JSON.stringify({
        id: 89,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-unknown',
          itemId: 'item-1',
        },
      })}\n`
    );

    await vi.waitFor(() => {
      const response = findRpcLineById(fake, 89);
      expect(response).toBeDefined();
      expect(response).toMatchObject({
        id: 89,
        error: expect.objectContaining({
          code: -32_602,
          message: 'No active session mapped for threadId: thread-unknown',
        }),
      });
    });
    expect(onServerRequest).not.toHaveBeenCalled();
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
      manager.request(
        'thread/read',
        { threadId: 't1', includeTurns: true },
        { timeoutMs: 5, threadId: 't1' }
      )
    ).rejects.toMatchObject({
      code: 'CODEX_REQUEST_TIMEOUT',
      retryable: true,
    });
  });

  it('rejects requests with invalid params before writing to transport', async () => {
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

    const lineCountBefore = fake.stdin.getLines().length;
    await expect(
      manager.request('thread/read', { includeTurns: true }, { threadId: 'thread-1' })
    ).rejects.toMatchObject({
      code: 'CODEX_REQUEST_INVALID_PARAMS',
    });

    const linesAfter = fake.stdin.getLines();
    expect(linesAfter.length).toBe(lineCountBefore);
    expect(linesAfter.some((line) => line.includes('"method":"thread/read"'))).toBe(false);
  });

  it('normalizes malformed transport error payloads for failed requests', async () => {
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
      { threadId: 'thread-1', includeTurns: true },
      { threadId: 'thread-1' }
    );

    await vi.waitFor(() => {
      expect(fake.stdin.getLines().some((line) => line.includes('"method":"thread/read"'))).toBe(
        true
      );
    });

    const requestLine = fake.stdin
      .getLines()
      .map((line) => parseRpcLine(line))
      .find((line) => line.method === 'thread/read');

    if (!requestLine?.id) {
      throw new Error('thread/read request not found in fake stdin');
    }

    fake.stdout.write(
      `${JSON.stringify({
        id: requestLine.id,
        error: {
          code: 'not-a-number',
          message: '',
        },
      })}\n`
    );

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_REQUEST_FAILED',
      metadata: {
        error: {
          code: -1,
          message: 'Unknown Codex app-server error',
        },
      },
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
      manager.request(
        'thread/read',
        { threadId: 'thread-1', includeTurns: true },
        { threadId: 'thread-1' }
      )
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
      { threadId: 'thread-1', includeTurns: true },
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

  it('keeps stopped status after intentional stop even when exit event fires', async () => {
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

    await manager.stop();

    expect(manager.getStatus()).toMatchObject({
      state: 'stopped',
      unavailableReason: null,
    });
  });

  it('ignores stale exit events from previously stopped process after restart', async () => {
    const stale = new FakeChildProcess({ pid: 1111, emitExitOnKill: false });
    const fresh = new FakeChildProcess({ pid: 2222 });
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi
          .fn()
          .mockImplementationOnce(() => stale)
          .mockImplementationOnce(() => fresh),
      },
    });

    const firstStart = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(stale.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(stale);
    await firstStart;

    await manager.stop();

    const secondStart = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fresh.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fresh);
    await secondStart;

    stale.emit('exit', 1, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(manager.getStatus()).toMatchObject({
      state: 'ready',
      unavailableReason: null,
      pid: 2222,
    });
  });

  it('ignores stale error events from previously stopped process after restart', async () => {
    const stale = new FakeChildProcess({ pid: 3333, emitExitOnKill: false });
    const fresh = new FakeChildProcess({ pid: 4444 });
    const manager = new CodexAppServerManager({
      processFactory: {
        spawn: vi
          .fn()
          .mockImplementationOnce(() => stale)
          .mockImplementationOnce(() => fresh),
      },
    });

    const firstStart = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(stale.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(stale);
    await firstStart;

    await manager.stop();

    const secondStart = manager.ensureStarted();
    await vi.waitFor(() => {
      expect(fresh.stdin.getLines().some((line) => line.includes('"method":"initialize"'))).toBe(
        true
      );
    });
    respondToInitialize(fresh);
    await secondStart;

    stale.emit('error', new Error('stale process error'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(manager.getStatus()).toMatchObject({
      state: 'ready',
      unavailableReason: null,
      pid: 4444,
    });
  });

  it('kills child process and stays unavailable when process emits error', async () => {
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

    fake.emit('error', new Error('boom'));

    await vi.waitFor(() => {
      expect(manager.getStatus().state).toBe('unavailable');
    });
    expect(fake.killSignals.length).toBeGreaterThan(0);
    expect(manager.getStatus().unavailableReason).toBe('spawn_failed');
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
});
