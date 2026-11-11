import { describe, expect, it, vi } from 'vitest';
import { gate, setupAuthority, settleConfig } from './session-config-authority.test-helpers';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

describe('inactive and independent configuration acceptance', () => {
  it('keeps independent sessions live while one native commit is blocked', async () => {
    const h = setupAuthority();
    h.addSession('other');
    const reading = gate();
    h.hooks.read = async (number) => {
      if (number === 1) {
        await reading.wait();
      }
    };
    h.native('second');
    await reading.started;
    await h.service.setSessionModel('other', 'third');
    expect(h.row('other').model).toBe('third');
    reading.release();
    await settleConfig();
    expect(h.row().model).toBe('second');
  });

  it.each(['cached', 'uninitialized'] as const)(
    'reroutes a validated inactive %s edit when a runtime appears at its persistence guard',
    async (kind) => {
      const h = setupAuthority();
      if (kind === 'cached') {
        h.native('first');
        await settleConfig();
      } else {
        h.clearSnapshot();
      }
      h.runtime.getClient.mockReturnValue(undefined);
      const update = h.repository.updateSession.bind(h.repository);
      const spy = vi
        .spyOn(h.repository, 'updateSession')
        .mockImplementationOnce((id, data, assertCurrent) => {
          h.installIdentity();
          h.runtime.getClient.mockReturnValue(h.handle);
          h.native('third');
          return update(id, data, assertCurrent);
        });
      try {
        await h.service.setSessionConfigOption('session', 'model', 'second');
        await settleConfig();
        expect(h.runtime.setSessionModel).toHaveBeenCalledOnce();
        expect(h.row().model).toBe('second');
        expect(h.models().at(-1)).toBe('second');
        expect(h.handle.configOptions[0]?.currentValue).toBe('second');
      } finally {
        spy.mockRestore();
      }
    }
  );
});
