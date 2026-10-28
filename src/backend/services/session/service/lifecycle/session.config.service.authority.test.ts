import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import {
  configOptions,
  gate,
  setupAuthority,
  settleConfig,
} from './session-config-authority.test-helpers';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

describe('accepted configuration commit authority', () => {
  it('keeps a newer public edit after an older native observation retries a real status CAS conflict', async () => {
    const h = setupAuthority();
    const retry = gate();
    h.hooks.cas = (number) => {
      if (number === 1) {
        h.statusWrite();
      }
      return Promise.resolve();
    };
    h.hooks.read = async (number) => {
      if (number === 3) {
        await retry.wait();
      }
    };
    h.native('second');
    await retry.started;
    await h.service.setSessionModel('session', 'third');
    retry.release();
    await settleConfig();
    expect(h.row().model).toBe('third');
    expect(parseAcpConfigSnapshot(h.row().providerMetadata)?.observedModelId).toBe('third');
    expect(h.row().status).toBe('RUNNING');
    expect(h.models()).toEqual(['second', 'third']);
    expect(h.handle.configOptions[0]?.currentValue).toBe('third');
  });

  it('fences native persistence after the repository row read returns a newer snapshot', async () => {
    const h = setupAuthority();
    const read = gate();
    h.hooks.read = async (number) => {
      if (number === 2) {
        await read.wait();
      }
    };
    h.native('second');
    await read.started;
    await h.service.setSessionModel('session', 'third');
    read.release();
    await settleConfig();
    expect(h.casModels).toEqual(['third']);
    expect(h.row().model).toBe('third');
  });

  it.each(['newer-first', 'older-first'] as const)(
    'preserves the newer accepted configuration with already issued SQL: %s',
    async (order) => {
      const h = setupAuthority();
      const oldSql = gate();
      const newSql = gate();
      h.hooks.cas = async (number) => {
        if (number === 1) {
          await oldSql.wait();
        }
        if (number === 2 && order === 'older-first') {
          await newSql.wait();
        }
      };
      h.native('second');
      await oldSql.started;
      const setting = h.service.setSessionModel('session', 'third');
      if (order === 'newer-first') {
        await setting;
        oldSql.release();
      } else {
        await newSql.started;
        oldSql.release();
        await settleConfig();
        newSql.release();
        await setting;
      }
      await settleConfig();
      expect(h.row().model).toBe('third');
      expect(parseAcpConfigSnapshot(h.row().providerMetadata)?.observedModelId).toBe('third');
      expect(h.accessor.update).not.toHaveBeenCalled();
      expect(h.models()).toEqual(['second', 'third']);
    }
  );

  it.each(['model', 'mode', 'reasoning'] as const)(
    'captures current handle options after a delayed %s RPC continuation',
    async (kind) => {
      const h = setupAuthority();
      const response = gate();
      if (kind === 'model') {
        h.runtime.setSessionModel.mockImplementationOnce(async (_id, value) => {
          const retained = await h.controller.setSessionModel(h.handle, value, 'session');
          await response.wait();
          return retained;
        });
      }
      if (kind === 'mode') {
        h.runtime.setSessionMode.mockImplementationOnce(async (_id, value) => {
          const retained = await h.controller.setSessionMode(h.handle, value, 'session');
          await response.wait();
          return retained;
        });
      }
      if (kind === 'reasoning') {
        h.runtime.setConfigOption.mockImplementationOnce(async (_id, id, value) => {
          const retained = await h.controller.setConfigOption(h.handle, id, value, 'session');
          await response.wait();
          return retained;
        });
      }
      const setting =
        kind === 'reasoning'
          ? h.service.setSessionReasoningEffort('session', 'high')
          : h.service.setSessionConfigOption(
              'session',
              kind,
              kind === 'mode' ? 'read-only' : 'second'
            );
      await response.started;
      h.native('third');
      response.release();
      await setting;
      await settleConfig();
      expect(h.handle.configOptions).toEqual(configOptions('third'));
      expect(h.row().model).toBe('third');
      expect(h.models()).toEqual(['third', 'third']);
    }
  );

  it('does not publish an obsolete edit after a delayed final repository reread', async () => {
    const h = setupAuthority();
    const reread = gate();
    h.hooks.read = async (number) => {
      if (number === 3) {
        await reread.wait();
      }
    };
    const setting = h.service.setSessionModel('session', 'second');
    await reread.started;
    h.native('third');
    await settleConfig();
    reread.release();
    await setting;
    expect(h.models()).toEqual(['third']);
    expect(h.row().model).toBe('third');
  });

  it.each(['unsupported', 'rpc-rejection'] as const)(
    'retains a valid native observation when a newer edit fails: %s',
    async (kind) => {
      const h = setupAuthority();
      const read = gate();
      const response = gate();
      h.hooks.read = async (number) => {
        if (number === 1) {
          await read.wait();
        }
      };
      h.native('second');
      await read.started;
      if (kind === 'unsupported') {
        await expect(h.service.setSessionModel('session', 'unavailable')).rejects.toThrow();
      } else {
        h.connection.setSessionConfigOption.mockImplementationOnce(async () => {
          await response.wait();
          throw new Error('provider rejected');
        });
        const setting = h.service.setSessionModel('session', 'first').catch((error) => error);
        await response.started;
        h.native('third');
        response.release();
        expect(await setting).toBeInstanceOf(Error);
      }
      read.release();
      await settleConfig();
      const expected = kind === 'unsupported' ? 'second' : 'third';
      expect(h.row().model).toBe(expected);
      expect(h.models().at(-1)).toBe(expected);
    }
  );

  it('preserves a native update during a rejecting mode request', async () => {
    const h = setupAuthority();
    const response = gate();
    h.connection.setSessionMode.mockImplementationOnce(async () => {
      await response.wait();
      throw new Error('mode rejected');
    });
    const setting = h.service
      .setSessionConfigOption('session', 'mode', 'read-only')
      .catch((error) => error);
    await response.started;
    h.native('third');
    response.release();
    expect(await setting).toBeInstanceOf(Error);
    await settleConfig();
    expect(h.row().model).toBe('third');
    expect(h.models()).toEqual(['third', 'third']);
  });

  it('accepts later native observations after a public edit and a delayed older native retry', async () => {
    const h = setupAuthority();
    const retry = gate();
    h.hooks.cas = (number) => {
      if (number === 1) {
        h.statusWrite();
      }
      return Promise.resolve();
    };
    h.hooks.read = async (number) => {
      if (number === 3) {
        await retry.wait();
      }
    };
    h.native('second');
    await retry.started;
    h.native('third');
    await settleConfig();
    retry.release();
    await settleConfig();
    expect(h.row().model).toBe('third');
    await h.service.setSessionModel('session', 'second');
    h.native('first');
    await settleConfig();
    expect(h.row().model).toBe('first');
    expect(h.models()).toEqual(['second', 'third', 'second', 'first']);
  });

  it.each(['replacement', 'stop'] as const)('fences old native commits after %s', async (kind) => {
    const h = setupAuthority();
    const read = gate();
    h.hooks.read = async (number) => {
      if (number === 2) {
        await read.wait();
      }
    };
    h.native('second');
    await read.started;
    if (kind === 'replacement') {
      h.runtime.getClient.mockReturnValue(createTestProcessHandle({ providerSessionId: 'thread' }));
    } else {
      h.runtime.isStopInProgress.mockReturnValue(true);
    }
    read.release();
    await settleConfig();
    expect(h.row().model).toBe('first');
    expect(h.casModels).toEqual([]);
  });

  it('persists startup outside the public readiness queue and supports synchronous RPC notifications', async () => {
    const h = setupAuthority();
    h.handle.deferPromptReadiness();
    const setting = h.service.setSessionModel('session', 'second');
    h.native('third');
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: h.handle.configOptions,
    });
    h.runtime.setSessionModel.mockImplementationOnce(async (_id, value) => {
      const response = await h.controller.setSessionModel(h.handle, value, 'session');
      h.native('first');
      return response;
    });
    h.handle.completeConfiguration();
    await setting;
    await settleConfig();
    expect(h.row().model).toBe('first');
    expect(h.models().at(-1)).toBe('first');
  });
});
