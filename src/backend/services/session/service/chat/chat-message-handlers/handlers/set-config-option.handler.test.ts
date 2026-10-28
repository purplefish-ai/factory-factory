import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetConfigOptionHandler } from './set-config-option.handler';

const setSessionConfigOption = vi.fn();
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), error: logError }),
}));
const handler = createSetConfigOptionHandler({
  sessionConfigService: { setSessionConfigOption },
});
const context = { sessionId: 'session-1', workingDir: '/tmp/work' };

describe('createSetConfigOptionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionConfigOption.mockResolvedValue(undefined);
  });

  it('updates the injected session configuration with plain values and no socket', async () => {
    const outcome = await handler(context, {
      type: 'set_config_option',
      configId: 'execution_mode',
      value: 'on-request',
    });
    expect(setSessionConfigOption).toHaveBeenCalledWith(
      'session-1',
      'execution_mode',
      'on-request'
    );
    expect(outcome).toEqual({ replies: [] });
  });

  it('acknowledges the request only after its deferred configuration finishes', async () => {
    let complete!: () => void;
    setSessionConfigOption.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      })
    );
    let settled = false;
    const result = handler(context, {
      type: 'set_config_option',
      configId: 'mode',
      value: 'plan',
      requestId: 'pending-edit',
    });
    const outcome = Promise.resolve(result).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete();
    expect(await outcome).toEqual({
      replies: [{ type: 'config_option_applied', requestId: 'pending-edit' }],
    });
  });

  it.each([undefined, 'config-request'])(
    'returns requester correlation %s while the service owns configuration correction',
    async (requestId) => {
      const cause = new Error('boom');
      setSessionConfigOption.mockRejectedValue(cause);
      const outcome = await handler(context, {
        type: 'set_config_option',
        ...(requestId !== undefined ? { requestId } : {}),
        configId: 'model',
        value: 'gpt-5-mini',
      });
      expect(outcome).toEqual({
        replies: [
          {
            type: 'error',
            error: { kind: 'set_config_option_failed', cause },
            ...(requestId !== undefined ? { requestId } : {}),
          },
        ],
      });
    }
  );

  it('does not correct with empty options when there is no live ACP handle', async () => {
    const cause = new Error('boom');
    setSessionConfigOption.mockRejectedValue(cause);
    const outcome = await handler(context, {
      type: 'set_config_option',
      configId: 'model',
      value: 'gpt-5-mini',
    });
    expect(outcome).toEqual({
      replies: [{ type: 'error', error: { kind: 'set_config_option_failed', cause } }],
    });
  });

  it.each([
    new Error('boom'),
    { data: { reason: 'invalid preset' } },
    { code: 403 },
    { message: 'invalid option' },
    42,
  ])('returns the original rejection %o for transport error formatting', async (cause) => {
    setSessionConfigOption.mockRejectedValue(cause);
    const outcome = await handler(context, {
      type: 'set_config_option',
      configId: 'mode',
      value: 'bad',
    });
    expect(outcome.replies).toEqual([
      { type: 'error', error: { kind: 'set_config_option_failed', cause } },
    ]);
  });

  it('passes circular rejections to the adapter without serializing them', async () => {
    const cause: { self?: unknown } = {};
    cause.self = cause;
    setSessionConfigOption.mockRejectedValue(cause);
    const outcome = await handler(context, {
      type: 'set_config_option',
      configId: 'mode',
      value: 'bad',
    });
    expect(outcome.replies).toEqual([
      { type: 'error', error: { kind: 'set_config_option_failed', cause } },
    ]);
  });

  it('retains structured ACP rejection details in the log context', async () => {
    const cause = { code: -32_602, message: 'Invalid configuration', data: { option: 'mode' } };
    setSessionConfigOption.mockRejectedValue(cause);
    await handler(context, { type: 'set_config_option', configId: 'mode', value: 'bad' });
    expect(logError).toHaveBeenCalledWith('[Chat WS] Failed to set config option', {
      sessionId: 'session-1',
      configId: 'mode',
      value: 'bad',
      error: cause,
    });
  });
});
