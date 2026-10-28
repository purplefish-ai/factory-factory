import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  markSessionLaunchSettingsApplied,
  readSessionLaunchSettings,
} from './session-launch-settings';
import { createLifecycleTestSession, createDeferred } from './session-lifecycle.test-helpers';
import { SessionConfigService } from './session.config.service';
import { SessionRepository } from './session.repository';
function options(effort: string): SessionConfigOption[] {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'model',
      options: [{ value: 'model', name: 'Model' }],
    },
    {
      id: 'effort',
      category: 'thought_level',
      name: 'Effort',
      type: 'select',
      currentValue: effort,
      options: ['low', 'medium'].map((value) => ({ value, name: value })),
    },
  ];
}
function fixture() {
  let row = createLifecycleTestSession({
    provider: 'CODEX',
    providerSessionId: 'thread',
    providerMetadata: unsafeCoerce({
      launchSettings: { reasoningEffort: 'medium', planModeEnabled: true, applied: false },
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: [
          ...options('medium'),
          {
            id: 'collaboration_mode',
            category: 'collaboration_mode',
            name: 'Plan',
            type: 'select',
            currentValue: 'plan',
            options: [
              { value: 'plan', name: 'Plan' },
              { value: 'default', name: 'Default' },
            ],
          },
        ],
      },
    }),
  });
  let failures = 0;
  const accessor = {
    findById: vi.fn(() => Promise.resolve(structuredClone(row))),
    updateIfProviderIdentity: vi.fn((_id: string, expected: typeof row, update: object) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error('Storage unavailable'));
      }
      if (
        expected.providerSessionId !== row.providerSessionId ||
        JSON.stringify(expected.providerMetadata) !== JSON.stringify(row.providerMetadata) ||
        +expected.updatedAt !== +row.updatedAt
      ) {
        return Promise.resolve(0);
      }
      row = { ...row, ...update, updatedAt: new Date(+row.updatedAt + 1) };
      return Promise.resolve(1);
    }),
  };
  const repository = new SessionRepository(unsafeCoerce(accessor), unsafeCoerce({}));
  const service = new SessionConfigService({
    repository,
    runtimeManager: unsafeCoerce({ getClient: vi.fn(), getPendingClient: vi.fn() }),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  const final = () =>
    service.persistAcpConfigSnapshot('session-1', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: options('medium'),
      existingMetadata: markSessionLaunchSettingsApplied(row.providerMetadata),
      requirePersistence: true,
    });
  return {
    accessor,
    repository,
    service,
    final,
    get row() {
      return row;
    },
    changeLaunch: (patch: { reasoningEffort?: string; planModeEnabled?: boolean }) => {
      row = {
        ...row,
        providerMetadata: {
          ...(row.providerMetadata as object),
          launchSettings: { ...readSessionLaunchSettings(row.providerMetadata), ...patch },
        },
      };
    },
    failWrites: (count: number) => {
      failures = count;
    },
  };
}
describe('durable final launch snapshot with production repository CAS', () => {
  it.each([
    {
      id: 'effort',
      value: 'low',
      expected: { reasoningEffort: 'low', planModeEnabled: true, applied: false },
    },
    {
      id: 'collaboration_mode',
      value: 'default',
      expected: { reasoningEffort: 'medium', planModeEnabled: false, applied: false },
    },
  ])(
    'retains explicit pending $id edits after a transient first write failure',
    async ({ id, value, expected }) => {
      const f = fixture();
      f.failWrites(1);
      await f.service.setSessionConfigOption('session-1', id, value);
      expect(readSessionLaunchSettings(f.row.providerMetadata)).toEqual(expected);
      expect(f.accessor.updateIfProviderIdentity).toHaveBeenCalledTimes(2);
    }
  );
  it('retries only the edited effort field while retaining freshly changed Plan intent', async () => {
    const f = fixture();
    f.accessor.updateIfProviderIdentity.mockImplementationOnce(() => {
      f.changeLaunch({ planModeEnabled: false });
      return Promise.reject(new Error('Transient failure'));
    });
    await f.service.setSessionConfigOption('session-1', 'effort', 'low');
    expect(readSessionLaunchSettings(f.row.providerMetadata)).toEqual({
      reasoningEffort: 'low',
      planModeEnabled: false,
      applied: false,
    });
  });
  it('retries only the edited Plan field while retaining freshly changed effort intent', async () => {
    const f = fixture();
    f.accessor.updateIfProviderIdentity.mockImplementationOnce(() => {
      f.changeLaunch({ reasoningEffort: 'low' });
      return Promise.reject(new Error('Transient failure'));
    });
    await f.service.setSessionConfigOption('session-1', 'collaboration_mode', 'default');
    expect(readSessionLaunchSettings(f.row.providerMetadata)).toEqual({
      reasoningEffort: 'low',
      planModeEnabled: false,
      applied: false,
    });
  });
  it.each([
    { id: 'effort', value: 'low' },
    { id: 'collaboration_mode', value: 'default' },
  ])('rejects stopped $id edits when both durable writes fail', async ({ id, value }) => {
    const f = fixture();
    f.failWrites(2);
    await expect(f.service.setSessionConfigOption('session-1', id, value)).rejects.toThrow(
      'Storage unavailable'
    );
    expect(readSessionLaunchSettings(f.row.providerMetadata)).toEqual({
      reasoningEffort: 'medium',
      planModeEnabled: true,
      applied: false,
    });
  });
  it('preserves consumed launch intent when the first final write fails and retry succeeds', async () => {
    const f = fixture();
    f.failWrites(1);
    await f.final();
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(true);
    expect(f.accessor.updateIfProviderIdentity).toHaveBeenCalledTimes(2);
  });
  it('rejects final startup commit when both persistence attempts fail', async () => {
    const f = fixture();
    f.failWrites(2);
    await expect(f.final()).rejects.toThrow('Storage unavailable');
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(false);
  });
  it('keeps native update failures best-effort and releases the following final commit', async () => {
    const f = fixture();
    f.failWrites(2);
    const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    f.service.applyConfigOptionsUpdateDelta('session-1', handle, options('low'));
    await f.final();
    expect(f.accessor.updateIfProviderIdentity).toHaveBeenCalledTimes(3);
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(true);
    expect(f.row.providerMetadata).toMatchObject({
      acpConfigSnapshot: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'effort', currentValue: 'medium' }),
        ]),
      },
    });
  });
  it('orders an earlier native-event write before the final commit instead of rewinding it later', async () => {
    const f = fixture();
    const reading = createDeferred<typeof f.row>();
    f.accessor.findById.mockReturnValueOnce(reading.promise);
    const native = f.service.persistAcpConfigSnapshot('session-1', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: options('low'),
    });
    await vi.waitFor(() => expect(f.accessor.findById).toHaveBeenCalled());
    let finished = false;
    const final = f.final().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeOlderWrite = finished;
    reading.resolve(structuredClone(f.row));
    await Promise.all([native, final]);
    expect(finishedBeforeOlderWrite).toBe(false);
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(true);
    expect(f.row.providerMetadata).toMatchObject({
      acpConfigSnapshot: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'effort', currentValue: 'medium' }),
        ]),
      },
    });
  });
  it('orders actual native updates paused inside the repository before final startup persistence', async () => {
    const f = fixture();
    const reading = createDeferred<typeof f.row>();
    f.accessor.findById
      .mockResolvedValueOnce(structuredClone(f.row))
      .mockReturnValueOnce(reading.promise);
    const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    f.service.applyConfigOptionsUpdateDelta('session-1', handle, options('low'));
    await vi.waitFor(() => expect(f.accessor.findById).toHaveBeenCalledTimes(2));
    let finished = false;
    const final = f.final().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeOlderWrite = finished;
    reading.resolve(structuredClone(f.row));
    await final;
    expect(finishedBeforeOlderWrite).toBe(false);
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(true);
    expect(f.row.providerMetadata).toMatchObject({
      acpConfigSnapshot: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'effort', currentValue: 'medium' }),
        ]),
      },
    });
  });
  it('makes applied launch intent monotonic even for a later writer carrying stale metadata', async () => {
    const f = fixture();
    const stale = {
      launchSettings: { reasoningEffort: 'medium', planModeEnabled: true, applied: false },
    };
    await f.final();
    await f.repository.updateSession('session-1', {
      providerMetadata: {
        ...stale,
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'thread',
          configOptions: [],
          capturedAt: new Date().toISOString(),
        },
      },
    });
    expect(readSessionLaunchSettings(f.row.providerMetadata)?.applied).toBe(true);
  });
});
