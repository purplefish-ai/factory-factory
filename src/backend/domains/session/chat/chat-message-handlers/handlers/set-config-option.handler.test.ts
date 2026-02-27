import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    setSessionConfigOption: mocks.setSessionConfigOption,
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSetConfigOptionHandler } from './set-config-option.handler';

describe('createSetConfigOptionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates session config option', async () => {
    mocks.setSessionConfigOption.mockResolvedValue(undefined);
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'set_config_option',
        configId: 'execution_mode',
        value: 'on-request',
      } as never,
    });

    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith(
      'session-1',
      'execution_mode',
      'on-request'
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends websocket error when update throws an Error', async () => {
    mocks.setSessionConfigOption.mockRejectedValue(new Error('boom'));
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'model', value: 'gpt-5' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Failed to set config option: boom' })
    );
  });

  it('uses structured data payload when error object has no message', async () => {
    mocks.setSessionConfigOption.mockRejectedValue({ data: { reason: 'invalid preset' } });
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'execution_mode', value: 'bad' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set config option: {"reason":"invalid preset"}',
      })
    );
  });

  it('falls back to ACP error code label for code-only errors', async () => {
    mocks.setSessionConfigOption.mockRejectedValue({ code: 403 });
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'mode', value: 'blocked' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set config option: ACP error (403)',
      })
    );
  });

  it('uses message property for non-Error objects', async () => {
    mocks.setSessionConfigOption.mockRejectedValue({ message: 'invalid option' });
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'model', value: 'bad' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set config option: invalid option',
      })
    );
  });

  it('falls back to JSON serialization for non-object errors', async () => {
    mocks.setSessionConfigOption.mockRejectedValue(42);
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'mode', value: 'bad' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set config option: 42',
      })
    );
  });

  it('falls back to String(error) when JSON serialization throws', async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    mocks.setSessionConfigOption.mockRejectedValue(circular);
    const ws = { send: vi.fn() };
    const handler = createSetConfigOptionHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_config_option', configId: 'mode', value: 'bad' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set config option: [object Object]',
      })
    );
  });
});
