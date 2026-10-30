import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAccountService } from './codex-account.service';
import type { AccountObservation, CodexRuntimeContext, NativeLogin } from './types';
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: logs.info, debug: vi.fn(), warn: logs.warn, error: vi.fn() }),
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const baseDir = await mkdtemp(join(tmpdir(), 'ff-accounts-'));
  directories.push(baseDir);
  const rows = [
    {
      id: 'codex-native-default',
      label: 'Native default',
      kind: 'NATIVE_DEFAULT' as 'NATIVE_DEFAULT' | 'MANAGED',
      enabled: true,
      identityKey: null as string | null,
    },
  ];
  const store = {
    list: async () => rows,
    get: async (id: string) => rows.find((row) => row.id === id) ?? null,
    create: (label: string) => {
      const row = {
        id: `account-${rows.length}`,
        label,
        kind: 'MANAGED' as const,
        enabled: true,
        identityKey: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    update: (id: string, data: { label?: string; enabled?: boolean; identityKey?: string }) => {
      const row = rows.find((row) => row.id === id)!;
      Object.assign(row, data);
      return Promise.resolve(row);
    },
  };
  const observation = (percent?: number): AccountObservation => ({
    authenticated: true,
    scopeVerified: true,
    identityKey: null as string | null,
    email: null,
    planType: null,
    models: ['gpt-test'],
    usage: {
      provider: 'CODEX' as const,
      status: percent === undefined ? ('unavailable' as const) : ('available' as const),
      windows:
        percent === undefined
          ? []
          : [{ id: 'codex:primary', label: '5 hour', usedPercent: percent, resetsAt: null }],
      updatedAt: new Date().toISOString(),
    },
  });
  const unverified = new Set<string>();
  const observations = new Map<string, ReturnType<typeof observation>>();
  const login = vi.fn<NativeLogin>();
  const probe = vi.fn((context: CodexRuntimeContext) => {
    const reading = observations.get(context.accountId) ?? observation();
    return Promise.resolve({
      ...reading,
      identityKey: unverified.has(context.accountId)
        ? null
        : (reading.identityKey ?? (reading.authenticated ? context.accountId : null)),
    });
  });
  const service = new CodexAccountService({
    store,
    config: {
      getBaseDir: () => baseDir,
      getCodexHome: () => '/legacy/codex',
      getCodexSessionsDir: () => '/legacy/history',
      getChildProcessEnv: () => ({
        OPENAI_API_KEY: 'secret',
        CODEX_HOME: '/legacy/codex',
        CODEX_SESSIONS_DIR: '/legacy/history',
        PATH: '/bin',
      }),
    },
    probe,
    login,
  });
  return { service, rows, observations, observation, baseDir, login, unverified, probe };
}
it('preserves native environment and isolates managed history and authentication', async () => {
  const { service, baseDir } = await fixture();
  const account = await service.createAccount('Personal');
  const legacy = await service.getRuntimeContext();
  expect(legacy.homeDir).toBe('/legacy/codex');
  expect(legacy.sessionsDir).toBe('/legacy/history');
  expect(legacy.env.OPENAI_API_KEY).toBe('secret');
  const managed = await service.getRuntimeContext(account.id);
  expect(managed.homeDir).toBe(join(baseDir, 'codex-accounts', account.id));
  expect(managed.sessionsDir).toBe(join(managed.homeDir, 'sessions'));
  expect(managed.env.OPENAI_API_KEY).toBeUndefined();
  expect(managed.env.CODEX_SESSIONS_DIR).toBeUndefined();
  expect(managed.env.CODEX_HOME).toBe(managed.homeDir);
  if (process.platform !== 'win32') {
    expect((await stat(managed.homeDir)).mode & 0o777).toBe(0o700);
  }
});
it('prefers known remaining quota over unknown and excludes exhausted accounts', async () => {
  const { service, observations, observation } = await fixture();
  const managed = await service.createAccount('Second');
  observations.set('codex-native-default', observation());
  observations.set(managed.id, observation(40));
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(managed.id);
  observations.set(managed.id, observation(100));
  service.invalidate();
  expect(await service.withAccountReservation({}, async (id) => id)).toBe('codex-native-default');
});
it('spreads concurrent reservations and releases failed reservations', async () => {
  const { service } = await fixture();
  const managed = await service.createAccount('Second');
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const first = service.withAccountReservation({}, async (id) => {
    acquired();
    await gate;
    return id;
  });
  await ready;
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(managed.id);
  finish();
  expect(await first).toBe('codex-native-default');
  await expect(
    service.withAccountReservation({ accountId: managed.id }, () => {
      return Promise.reject(new Error('creation failed'));
    })
  ).rejects.toThrow('creation failed');
  expect(await service.withAccountReservation({}, async (id) => id)).toBe('codex-native-default');
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(managed.id);
});
it('does not silently rebind a profile after native identity changes', async () => {
  const { service, observations, observation } = await fixture();
  const account = await service.createAccount('Work');
  observations.set(account.id, { ...observation(), identityKey: 'original' });
  await service.getRuntimeContext(account.id);
  observations.set(account.id, { ...observation(), identityKey: 'changed' });
  service.invalidate();
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('identity');
});
it('keeps single native installations usable and honors manual disabled accounts', async () => {
  const { service } = await fixture();
  expect(await service.withAccountReservation({}, async (id) => id)).toBe('codex-native-default');
  const account = await service.createAccount('Disabled');
  await service.updateAccount(account.id, { enabled: false });
  expect(await service.withAccountReservation({ accountId: account.id }, async (id) => id)).toBe(
    account.id
  );
});
it('previews usable managed Auto without changing assignment rotation', async () => {
  const { service, observations, observation } = await fixture();
  const account = await service.createAccount('Work');
  observations.set('codex-native-default', { ...observation(), authenticated: false });
  expect((await service.getPreviewRuntimeContext()).accountId).toBe(account.id);
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(account.id);
});
it('rejects every known exhausted account', async () => {
  const { service, observations, observation } = await fixture();
  observations.set('codex-native-default', observation(100));
  await expect(service.withAccountReservation({}, async (id) => id)).rejects.toThrow(
    'remaining capacity'
  );
});
it('logs why each Auto candidate was skipped', async () => {
  const { service, observations, observation, probe } = await fixture();
  const exhausted = await service.createAccount('Exhausted');
  const usable = await service.createAccount('Usable');
  observations.set(exhausted.id, observation(100));
  observations.set(usable.id, observation(10));
  const read = probe.getMockImplementation()!;
  probe.mockImplementation((context) =>
    context.accountId === 'codex-native-default'
      ? Promise.reject(new Error('Codex native account operation failed'))
      : read(context)
  );
  logs.info.mockClear();
  logs.warn.mockClear();
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(usable.id);
  expect(logs.warn).toHaveBeenCalledWith('Skipping Codex account: account status check failed', {
    accountId: 'codex-native-default',
    error: 'Codex native account operation failed',
  });
  expect(logs.info).toHaveBeenCalledWith('Skipping Codex account: no remaining capacity', {
    accountId: exhausted.id,
  });
});
it('refuses duplicate identities including the native default', async () => {
  const { service, observations, observation } = await fixture();
  observations.set('codex-native-default', { ...observation(), identityKey: 'same' });
  await service.getAccounts();
  const account = await service.createAccount('Duplicate');
  observations.set(account.id, { ...observation(), identityKey: 'same' });
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('already connected');
});
it('serializes browser logins and cancellation frees the native callback port', async () => {
  const { service, login } = await fixture();
  const one = await service.createAccount('One');
  const two = await service.createAccount('Two');
  login.mockImplementation((_context, signal, onUrl) => {
    onUrl('https://auth.openai.com/oauth/authorize');
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('private native stderr')), {
        once: true,
      })
    );
  });
  expect((await service.startLogin(one.id)).status).toBe('pending');
  await expect(service.startLogin(two.id)).rejects.toThrow('in progress');
  expect((await service.cancelLogin(one.id)).status).toBe('cancelled');
  expect((await service.startLogin(two.id)).status).toBe('pending');
  await service.shutdown();
  expect(service.getLoginStatus(two.id).status).toBe('cancelled');
  expect(JSON.stringify(service.getLoginStatus(one.id))).not.toContain('private native stderr');
});
it('fails re-login to a different identity and keeps the persisted binding', async () => {
  const { service, observations, observation, login, rows } = await fixture();
  const account = await service.createAccount('Original');
  observations.set(account.id, { ...observation(), identityKey: 'original' });
  await service.getRuntimeContext(account.id);
  login.mockImplementation(() => {
    observations.set(account.id, { ...observation(), identityKey: 'replacement' });
    return Promise.resolve();
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('failed'));
  expect(rows.find((row) => row.id === account.id)?.identityKey).toBe('original');
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('identity');
});
it('filters unavailable models and applies the requested model quota', async () => {
  const { service, observations, observation } = await fixture();
  const second = await service.createAccount('Second');
  const limited = observation(20);
  limited.usage.windows.push({
    id: 'gpt-test:primary',
    label: 'Model',
    usedPercent: 100,
    resetsAt: null,
  });
  observations.set('codex-native-default', limited);
  observations.set(second.id, observation(50));
  expect(await service.withAccountReservation({ model: 'gpt-test' }, async (id) => id)).toBe(
    second.id
  );
  await expect(
    service.withAccountReservation({ model: 'unavailable-model' }, async (id) => id)
  ).rejects.toThrow('remaining capacity');
});
it('does not fall back from a missing persisted account to the native default', async () => {
  const { service } = await fixture();
  await expect(service.getRuntimeContext('deleted-account')).rejects.toThrow('no longer exists');
});
it('validates new labels before persistence', async () => {
  const { service, rows } = await fixture();
  await expect(service.createAccount('   ')).rejects.toThrow();
  expect(rows).toHaveLength(1);
});
it('requires verified identity for a managed authenticated account', async () => {
  const { service, unverified } = await fixture();
  const account = await service.createAccount('Unverified');
  unverified.add(account.id);
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow(
    'identity could not be verified'
  );
});
it('creates file credentials and rejects a managed keyring credential store', async () => {
  const { service, baseDir } = await fixture();
  const account = await service.createAccount('Managed');
  const path = join(baseDir, 'codex-accounts', account.id, 'config.toml');
  expect(await readFile(path, 'utf8')).toContain('cli_auth_credentials_store = "file"');
  await writeFile(path, 'cli_auth_credentials_store = "keyring"\n');
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('credential store');
});

it('rejects unsupported explicit models before preview or session reservation', async () => {
  const { service } = await fixture();
  const account = await service.createAccount('Selected');
  const persist = vi.fn(async (id: string) => id);
  await expect(
    service.withAccountReservation({ accountId: account.id, model: 'unsupported' }, persist)
  ).rejects.toThrow('model');
  expect(persist).not.toHaveBeenCalled();
  await expect(
    service.getPreviewRuntimeContext({ accountId: account.id, model: 'unsupported' })
  ).rejects.toThrow('model');
  expect(
    await service.withAccountReservation({ accountId: account.id, model: 'gpt-test' }, persist)
  ).toBe(account.id);
});
it('keeps native identity pinned and recovers after signing back into the original account', async () => {
  const { service, observations, observation, rows } = await fixture();
  const id = 'codex-native-default';
  observations.set(id, { ...observation(), identityKey: 'original' });
  await service.getRuntimeContext(id);
  observations.set(id, { ...observation(), identityKey: 'replacement' });
  service.invalidate();
  await expect(service.getRuntimeContext(id)).rejects.toThrow('ff codex login');
  expect(rows[0]?.identityKey).toBe('original');
  observations.set(id, { ...observation(), identityKey: 'original' });
  service.invalidate();
  expect((await service.getRuntimeContext(id)).accountId).toBe(id);
});

it.each(['m', 'default', undefined])(
  'Auto admits only accounts supporting requested effort for model %s',
  async (model) => {
    const { service, observations, observation } = await fixture();
    const high = await service.createAccount('High effort');
    for (const [id, efforts, percent] of [
      ['codex-native-default', ['low'], 10],
      [high.id, ['low', 'high'], 80],
    ] as const) {
      observations.set(id, {
        ...observation(percent),
        models: ['m'],
        modelCatalog: [
          {
            id: 'm',
            model: 'm',
            isDefault: true,
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
          },
        ],
      });
    }
    expect(
      await service.withAccountReservation({ model, reasoningEffort: 'high' }, async (id) => id)
    ).toBe(high.id);
    expect(
      (await service.getPreviewRuntimeContext({ model, reasoningEffort: 'high' })).accountId
    ).toBe(high.id);
    for (const reasoningEffort of [null, 'default']) {
      expect(
        await service.withAccountReservation({ model, reasoningEffort }, async (id) => id)
      ).toBe('codex-native-default');
    }
  }
);
it('rejects incompatible explicit effort before persistence and resolves default-model metadata', async () => {
  const { service, observations, observation } = await fixture();
  const id = 'codex-native-default';
  observations.set(id, {
    ...observation(10),
    models: ['m', 'other'],
    modelCatalog: [
      {
        id: 'other',
        model: 'other',
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
      {
        id: 'm',
        model: 'm',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
    ],
  });
  const persist = vi.fn(async (accountId: string) => accountId);
  await expect(
    service.withAccountReservation(
      { accountId: id, model: 'default', reasoningEffort: 'high' },
      persist
    )
  ).rejects.toThrow('reasoning effort');
  expect(persist).not.toHaveBeenCalled();
  await expect(
    service.getPreviewRuntimeContext({ accountId: id, model: 'm', reasoningEffort: 'high' })
  ).rejects.toThrow('reasoning effort');
  for (const reasoningEffort of [undefined, null, 'default', 'low']) {
    expect(
      await service.withAccountReservation(
        { accountId: id, model: 'default', reasoningEffort },
        persist
      )
    ).toBe(id);
  }
});
it('lists enabled account IDs without any native probes', async () => {
  const { service, rows, probe } = await fixture();
  const account = await service.createAccount('Managed');
  rows[0]!.enabled = false;
  expect(await service.getEnabledAccountIds()).toEqual([account.id]);
  expect(probe).not.toHaveBeenCalled();
});
