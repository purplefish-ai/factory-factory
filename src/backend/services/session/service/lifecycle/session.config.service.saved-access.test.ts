import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));

function setup(
  provider: 'CODEX' | 'CLAUDE' = 'CODEX',
  saved = 'read-only',
  outcome: AcpProcessHandle['sessionCreationOutcome'] = { kind: 'resumed' }
) {
  const values =
    provider === 'CODEX'
      ? ['read-only', 'workspace-write', 'agent', 'agent-full-access']
      : ['plan', 'default', 'acceptEdits', 'bypassPermissions', 'auto'];
  const access = (value: string): SessionConfigOption => ({
    id: 'mode',
    name: 'Access',
    category: 'mode',
    type: 'select',
    currentValue: value,
    options: values.map((value) => ({ value, name: value })),
  });
  const session = {
    id: 'session',
    provider,
    providerSessionId: 'thread',
    workflow: 'code',
    providerMetadata: {
      acpConfigSnapshot: {
        provider,
        providerSessionId: 'thread',
        capturedAt: new Date(0).toISOString(),
        configOptions: [access(saved)],
      },
    },
  };
  const handle = unsafeCoerce<AcpProcessHandle>({
    provider,
    providerSessionId: 'thread',
    configOptions: [access(values[1]!)],
    sessionCreationOutcome: outcome,
  });
  const applyOption = (_id: string, optionId: string, value: string) => {
    handle.configOptions = handle.configOptions.map((option) =>
      option.id === optionId ? ({ ...option, currentValue: value } as SessionConfigOption) : option
    );
    return Promise.resolve(handle.configOptions);
  };
  const runtime = {
    isStopInProgress: vi.fn().mockReturnValue(false),
    getClient: vi.fn(() => handle as AcpProcessHandle | undefined),
    setSessionMode: vi.fn((_sessionId: string, value: string) => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.type === 'select' && option.category === 'mode'
          ? { ...option, currentValue: value }
          : option
      );
      return Promise.resolve(handle.configOptions);
    }),
    setConfigOption: vi.fn(applyOption),
  };
  const repository = {
    getSessionById: vi.fn(() => Promise.resolve(session)),
    updateSession: vi.fn(),
  };
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  return { service, session, handle, runtime, repository, access };
}

describe('saved native session access', () => {
  it.each(['STRICT', 'RELAXED', 'YOLO'] as const)(
    'restores read-only instead of global %s',
    async (preset) => {
      const h = setup();
      await h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        preset
      );
      expect(h.runtime.setSessionMode).toHaveBeenCalledWith('session', 'read-only');
      expect(h.handle.configOptions[0]?.currentValue).toBe('read-only');
    }
  );

  it('restores a category-based native access mode with a custom ID', async () => {
    const h = setup();
    h.session.providerMetadata.acpConfigSnapshot.configOptions = [
      { ...h.access('read-only'), id: 'native-access' },
    ];
    h.handle.configOptions = [{ ...h.access('workspace-write'), id: 'native-access' }];
    await h.service.applyConfiguredPermissionPreset(
      'session',
      unsafeCoerce(h.session),
      h.handle,
      'YOLO'
    );
    expect(h.runtime.setSessionMode).toHaveBeenCalledWith('session', 'read-only');
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.handle.configOptions[0]).toMatchObject({
      id: 'native-access',
      currentValue: 'read-only',
    });
  });

  it.each(['plan', 'default', 'acceptEdits', 'bypassPermissions'])(
    'restores Claude native %s access',
    async (saved) => {
      const h = setup('CLAUDE', saved);
      h.handle.configOptions = [h.access('plan')];
      await h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      );
      expect(h.handle.configOptions[0]?.currentValue).toBe(saved);
    }
  );

  it('resumes saved Claude Auto access when the adapter applies its Accept edits fallback', async () => {
    const h = setup('CLAUDE', 'auto');
    // Claude's adapter applies Accept edits when the model lacks Auto mode.
    const apply = h.runtime.setSessionMode.getMockImplementation()!;
    h.runtime.setSessionMode.mockImplementation((sessionId, value) =>
      apply(sessionId, value === 'auto' ? 'acceptEdits' : value)
    );
    await h.service.applyConfiguredPermissionPreset(
      'session',
      unsafeCoerce(h.session),
      h.handle,
      'RELAXED'
    );
    expect(h.runtime.setSessionMode).toHaveBeenCalledWith('session', 'auto');
    expect(h.handle.configOptions[0]?.currentValue).toBe('acceptEdits');
  });

  it('rejects saved Claude Auto access that the adapter broadens', async () => {
    const h = setup('CLAUDE', 'auto');
    const apply = h.runtime.setSessionMode.getMockImplementation()!;
    h.runtime.setSessionMode.mockImplementation((sessionId, value) =>
      apply(sessionId, value === 'auto' ? 'bypassPermissions' : value)
    );
    await expect(
      h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'RELAXED'
      )
    ).rejects.toThrow('not applied');
  });

  it.each(['missing', 'new'] as const)(
    'initializes configured access for %s snapshots',
    async (kind) => {
      const h = setup();
      const session = {
        ...h.session,
        providerMetadata: null,
        providerSessionId: kind === 'new' ? null : 'thread',
      };
      const durableSession = { ...session };
      h.repository.getSessionById.mockImplementation(() =>
        Promise.resolve(unsafeCoerce(durableSession))
      );
      h.repository.updateSession.mockImplementation((_sessionId, update) => {
        Object.assign(durableSession, update);
        return Promise.resolve(unsafeCoerce(durableSession));
      });
      if (kind === 'new') {
        // Startup persists the provider identity before configuration can be saved.
        await h.repository.updateSession('session', {
          providerSessionId: h.handle.providerSessionId,
        });
      }
      h.handle.configOptions = [h.access('read-only')];
      await h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(session),
        h.handle,
        'STRICT'
      );
      expect(h.handle.configOptions[0]?.currentValue).toBe('workspace-write');
      expect(h.repository.updateSession).toHaveBeenLastCalledWith(
        'session',
        expect.objectContaining({
          providerMetadata: expect.objectContaining({
            acpConfigSnapshot: expect.objectContaining({ providerSessionId: 'thread' }),
          }),
        }),
        expect.any(Function)
      );
    }
  );

  it.each(['malformed', 'provider', 'identity', 'unavailable', 'missing-access'] as const)(
    'fails closed on present %s saved access',
    async (kind) => {
      const h = setup();
      const snapshot = h.session.providerMetadata.acpConfigSnapshot;
      if (kind === 'malformed') {
        snapshot.configOptions = unsafeCoerce([{ type: 'invalid' }]);
      }
      if (kind === 'provider') {
        snapshot.provider = 'CLAUDE';
      }
      if (kind === 'identity') {
        snapshot.providerSessionId = 'foreign';
      }
      if (kind === 'unavailable') {
        snapshot.configOptions = [h.access('unknown')];
      }
      if (kind === 'missing-access') {
        snapshot.configOptions = [];
      }
      await expect(
        h.service.applyConfiguredPermissionPreset(
          'session',
          unsafeCoerce(h.session),
          h.handle,
          'YOLO'
        )
      ).rejects.toThrow();
      expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
      expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
      expect(h.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it('carries access through an audited fallback identity chain', async () => {
    const h = setup('CODEX', 'read-only', {
      kind: 'resume_fallback',
      previousProviderSessionId: 'thread',
      reason: 'load_failed',
    });
    h.handle.providerSessionId = 'replacement';
    const rollovers = [
      {
        previousProviderSessionId: 'thread',
        providerSessionId: 'replacement',
        runtimeIncarnationId: 'incarnation-1',
      },
    ];
    h.repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        ...h.session,
        providerSessionId: 'replacement',
        providerMetadata: {
          ...h.session.providerMetadata,
          providerIdentityRollovers: rollovers,
          retainedMetadata: 'preserved',
        },
      })
    );
    await h.service.applyConfiguredPermissionPreset(
      'session',
      unsafeCoerce(h.session),
      h.handle,
      'YOLO'
    );
    expect(h.handle.configOptions[0]?.currentValue).toBe('read-only');
    expect(h.repository.updateSession).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        providerMetadata: expect.objectContaining({
          providerIdentityRollovers: rollovers,
          retainedMetadata: 'preserved',
          acpConfigSnapshot: expect.objectContaining({ providerSessionId: 'replacement' }),
        }),
      }),
      expect.any(Function)
    );
  });

  it('rejects an unrelated runtime identity', async () => {
    const h = setup();
    h.handle.providerSessionId = 'unrelated';
    await expect(
      h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      )
    ).rejects.toThrow();
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
  });

  it.each(['wrong-category', 'duplicate-id', 'ambiguous-access', 'ambiguous-planning'] as const)(
    'rejects %s native mode metadata before changing access',
    async (kind) => {
      const h = setup();
      const snapshot = h.session.providerMetadata.acpConfigSnapshot;
      if (kind === 'wrong-category') {
        snapshot.configOptions = [{ ...h.access('read-only'), id: 'model' }];
        h.handle.configOptions.push({ ...h.access('read-only'), id: 'model', category: 'model' });
      } else if (kind === 'duplicate-id') {
        snapshot.configOptions.push(h.access('agent-full-access'));
      } else if (kind === 'ambiguous-access') {
        snapshot.configOptions.push({ ...h.access('agent-full-access'), id: 'other-access' });
      } else {
        const planning: SessionConfigOption = {
          id: 'collaboration_mode',
          name: 'Planning',
          type: 'select',
          category: 'collaboration_mode',
          currentValue: 'plan',
          options: [{ value: 'plan', name: 'Plan' }],
        };
        snapshot.configOptions.push(planning, { ...planning, id: 'other-planning' });
        h.handle.configOptions.push(planning);
      }
      await expect(
        h.service.applyConfiguredPermissionPreset(
          'session',
          unsafeCoerce(h.session),
          h.handle,
          'YOLO'
        )
      ).rejects.toThrow();
      expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
      expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    }
  );

  it('restores independent Codex planning together with read-only access', async () => {
    const h = setup();
    const collaboration = (currentValue: string): SessionConfigOption => ({
      id: 'collaboration_mode',
      name: 'Planning',
      category: 'collaboration_mode',
      type: 'select',
      currentValue,
      options: ['default', 'plan'].map((value) => ({ value, name: value })),
    });
    h.session.providerMetadata.acpConfigSnapshot.configOptions.push(collaboration('plan'));
    h.handle.configOptions.push(collaboration('default'));
    await h.service.applyConfiguredPermissionPreset(
      'session',
      unsafeCoerce(h.session),
      h.handle,
      'YOLO'
    );
    expect(h.handle.configOptions.map((option) => option.currentValue)).toEqual([
      'read-only',
      'plan',
    ]);
  });

  it('rejects a custom access ID that now identifies the planning control', async () => {
    const h = setup();
    const saved: SessionConfigOption = {
      id: 'custom',
      name: 'Access',
      category: 'mode',
      type: 'select',
      currentValue: 'plan',
      options: [{ value: 'plan', name: 'Plan' }],
    };
    h.session.providerMetadata.acpConfigSnapshot.configOptions = [saved];
    h.handle.configOptions = [
      { ...saved, category: 'collaboration_mode' },
      { ...h.access('agent-full-access'), id: 'access-control' },
    ];
    await expect(
      h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      )
    ).rejects.toThrow();
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    expect(h.repository.updateSession).not.toHaveBeenCalled();
  });

  it('rejects unavailable saved planning before changing access', async () => {
    const h = setup();
    const collaboration = (values: string[], currentValue: string): SessionConfigOption => ({
      id: 'collaboration_mode',
      name: 'Planning',
      type: 'select',
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    h.session.providerMetadata.acpConfigSnapshot.configOptions.push(
      collaboration(['default', 'plan'], 'plan')
    );
    h.handle.configOptions.push(collaboration(['default'], 'default'));
    await expect(
      h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      )
    ).rejects.toThrow('unavailable');
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
  });

  it('does not configure or persist a replacement runtime after restoring access', async () => {
    const h = setup();
    const collaboration: SessionConfigOption = {
      id: 'collaboration_mode',
      name: 'Planning',
      type: 'select',
      currentValue: 'plan',
      options: ['default', 'plan'].map((value) => ({ value, name: value })),
    };
    h.session.providerMetadata.acpConfigSnapshot.configOptions.push(collaboration);
    h.handle.configOptions.push({ ...collaboration, currentValue: 'default' });
    const original = h.runtime.setSessionMode.getMockImplementation()!;
    h.runtime.setSessionMode.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      h.runtime.getClient.mockReturnValue(undefined);
      return result;
    });
    await expect(
      h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      )
    ).rejects.toThrow();
    expect(h.runtime.setSessionMode).toHaveBeenCalledTimes(1);
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.repository.updateSession).not.toHaveBeenCalled();
  });

  it.each(['read-only', 'workspace-write'])(
    'migrates legacy %s access and planning conservatively',
    async (sandbox) => {
      const h = setup();
      const legacy = (id: string, currentValue: string): SessionConfigOption => ({
        id,
        name: id,
        category: id,
        type: 'select',
        currentValue,
        options: [{ value: currentValue, name: currentValue }],
      });
      h.session.providerMetadata.acpConfigSnapshot.configOptions = [
        legacy('mode', 'plan'),
        legacy('execution_mode', JSON.stringify(['on-request', sandbox])),
      ];
      h.handle.configOptions.push({
        id: 'collaboration_mode',
        name: 'Planning',
        type: 'select',
        currentValue: 'default',
        options: ['default', 'plan'].map((value) => ({ value, name: value })),
      });
      await h.service.applyConfiguredPermissionPreset(
        'session',
        unsafeCoerce(h.session),
        h.handle,
        'YOLO'
      );
      expect(h.handle.configOptions.map((option) => option.currentValue)).toEqual([
        sandbox,
        'plan',
      ]);
    }
  );
});
