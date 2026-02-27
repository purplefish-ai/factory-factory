import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interceptorRegistry } from './registry';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

function resetRegistryState() {
  const mutableRegistry = interceptorRegistry as unknown as {
    interceptors: ToolInterceptor[];
    started: boolean;
  };
  mutableRegistry.interceptors = [];
  mutableRegistry.started = false;
}

const event: ToolEvent = {
  toolUseId: 'tool-1',
  toolName: 'Bash',
  input: { command: 'pnpm test' },
};

const context: InterceptorContext = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  workingDir: '/tmp/workspace',
  timestamp: new Date('2026-02-27T00:00:00.000Z'),
};

describe('interceptorRegistry', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await interceptorRegistry.stop();
    resetRegistryState();
  });

  it('skips duplicate registrations by interceptor name', async () => {
    const registry = interceptorRegistry;
    const startA = vi.fn();
    const startB = vi.fn();
    const onToolStart = vi.fn(async () => undefined);

    registry.register({
      name: 'dup',
      tools: ['Bash'],
      start: startA,
      onToolStart,
    });
    registry.register({
      name: 'dup',
      tools: ['Bash'],
      start: startB,
      onToolStart: vi.fn(async () => undefined),
    });

    await registry.start();
    registry.notifyToolStart(event, context);

    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).not.toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledTimes(1);
  });

  it('starts registered interceptors and starts newly-registered ones after start', async () => {
    const registry = interceptorRegistry;
    const startOne = vi.fn(async () => undefined);
    const startTwo = vi.fn(async () => undefined);

    registry.register({ name: 'one', tools: '*', start: startOne });
    await registry.start();
    registry.register({ name: 'two', tools: '*', start: startTwo });

    expect(startOne).toHaveBeenCalledTimes(1);
    expect(startTwo).toHaveBeenCalledTimes(1);
  });

  it('swallows start/stop hook errors and still processes others', async () => {
    const registry = interceptorRegistry;
    const goodStart = vi.fn(async () => undefined);
    const goodStop = vi.fn(async () => undefined);
    const badStart = vi.fn(() => Promise.reject(new Error('start failed')));
    const badStop = vi.fn(() => Promise.reject(new Error('stop failed')));

    registry.register({ name: 'good', tools: '*', start: goodStart, stop: goodStop });
    registry.register({ name: 'bad', tools: '*', start: badStart, stop: badStop });

    await expect(registry.start()).resolves.toBeUndefined();
    await expect(registry.stop()).resolves.toBeUndefined();

    expect(goodStart).toHaveBeenCalledTimes(1);
    expect(goodStop).toHaveBeenCalledTimes(1);
    expect(badStart).toHaveBeenCalledTimes(1);
    expect(badStop).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('notifies only matching interceptors for start and complete events', () => {
    const registry = interceptorRegistry;
    const onStartAny = vi.fn(async () => undefined);
    const onStartBash = vi.fn(async () => undefined);
    const onStartOther = vi.fn(async () => undefined);
    const onCompleteBash = vi.fn(async () => undefined);

    registry.register({
      name: 'any',
      tools: '*',
      onToolStart: onStartAny,
    });
    registry.register({
      name: 'bash',
      tools: ['Bash'],
      onToolStart: onStartBash,
      onToolComplete: onCompleteBash,
    });
    registry.register({
      name: 'other',
      tools: ['Edit'],
      onToolStart: onStartOther,
    });

    registry.notifyToolStart(event, context);
    registry.notifyToolComplete(event, context);

    expect(onStartAny).toHaveBeenCalledWith(event, context);
    expect(onStartBash).toHaveBeenCalledWith(event, context);
    expect(onStartOther).not.toHaveBeenCalled();
    expect(onCompleteBash).toHaveBeenCalledWith(event, context);
  });

  it('handles fire-and-forget interceptor failures for start/complete callbacks', async () => {
    const registry = interceptorRegistry;
    const failStart = vi.fn(() => Promise.reject(new Error('start callback failure')));
    const failComplete = vi.fn(() => Promise.reject(new Error('complete callback failure')));

    registry.register({
      name: 'unstable',
      tools: ['Bash'],
      onToolStart: failStart,
      onToolComplete: failComplete,
    });

    registry.notifyToolStart(event, context);
    registry.notifyToolComplete(event, context);
    await Promise.resolve();
    await Promise.resolve();

    expect(failStart).toHaveBeenCalledTimes(1);
    expect(failComplete).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('is a no-op when start is called twice', async () => {
    const registry = interceptorRegistry;
    const interceptor: ToolInterceptor = {
      name: 'idempotent',
      tools: '*',
      start: vi.fn(async () => undefined),
    };
    registry.register(interceptor);

    await registry.start();
    await registry.start();

    expect(interceptor.start).toHaveBeenCalledTimes(1);
  });
});
