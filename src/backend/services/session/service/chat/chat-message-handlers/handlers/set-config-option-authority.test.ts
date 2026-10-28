import { expect, it, vi } from 'vitest';
import {
  gate,
  setupAuthority,
  settleConfig,
} from '@/backend/services/session/service/lifecycle/session-config-authority.test-helpers';
import { createSetConfigOptionHandler } from './set-config-option.handler';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

it('publishes the superseding native selection before acknowledging a settled edit', async () => {
  const h = setupAuthority();
  const reread = gate();
  h.hooks.read = async (number) => {
    if (number === 3) {
      await reread.wait();
    }
  };
  const handler = createSetConfigOptionHandler({ sessionConfigService: h.service });
  const result = handler(
    { sessionId: 'session', workingDir: '/tmp' },
    {
      type: 'set_config_option',
      configId: 'model',
      value: 'second',
      requestId: 'pending-edit',
    }
  );
  await reread.started;
  h.native('third');
  await settleConfig();
  reread.release();
  const outcome = await result;
  expect(h.models()).toEqual(['third']);
  expect(h.row().model).toBe('third');
  expect(outcome.replies).toEqual([{ type: 'config_option_applied', requestId: 'pending-edit' }]);
});

it('returns a correlated error when the runtime changes before an edit settles', async () => {
  const h = setupAuthority();
  const reread = gate();
  h.hooks.read = async (number) => {
    if (number === 3) {
      await reread.wait();
    }
  };
  const handler = createSetConfigOptionHandler({ sessionConfigService: h.service });
  const result = handler(
    { sessionId: 'session', workingDir: '/tmp' },
    {
      type: 'set_config_option',
      configId: 'model',
      value: 'second',
      requestId: 'pending-edit',
    }
  );
  await reread.started;
  h.runtime.isStopInProgress.mockReturnValue(true);
  reread.release();
  const outcome = await result;
  expect(outcome.replies).toEqual([
    {
      type: 'error',
      requestId: 'pending-edit',
      error: {
        kind: 'set_config_option_failed',
        cause: expect.objectContaining({
          message: 'Session runtime changed before configuration update',
        }),
      },
    },
  ]);
});

it('does not acknowledge a configuration whose durable write rejects', async () => {
  const h = setupAuthority();
  const failure = new Error('Snapshot storage unavailable');
  h.hooks.cas = () => Promise.reject(failure);
  const handler = createSetConfigOptionHandler({ sessionConfigService: h.service });
  const outcome = await handler(
    { sessionId: 'session', workingDir: '/tmp' },
    {
      type: 'set_config_option',
      configId: 'model',
      value: 'second',
      requestId: 'pending-edit',
    }
  );
  expect(outcome.replies).toEqual([
    {
      type: 'error',
      requestId: 'pending-edit',
      error: { kind: 'set_config_option_failed', cause: failure },
    },
  ]);
});
