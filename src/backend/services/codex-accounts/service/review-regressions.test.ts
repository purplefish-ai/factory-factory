import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAccountService } from './codex-account.service';
import { nativeEmailFallbackKey } from './identity';
import type { AccountObservation, AccountRow, CodexRuntimeContext, NativeLogin } from './types';
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'ff-account-review-'));
  cleanup.push(base);
  const native = join(base, 'native');
  await mkdir(native);
  const rows: AccountRow[] = [
    {
      id: 'codex-native-default',
      kind: 'NATIVE_DEFAULT',
      label: 'Default',
      enabled: true,
      identityKey: null,
    },
  ];
  const makeObservation = (id: string): AccountObservation => ({
    authenticated: true,
    scopeVerified: true,
    identityKey: id,
    email: `${id}@example.com`,
    planType: 'pro',
    models: ['model-b', 'alias-b'],
    modelCatalog: [
      { id: 'model-b', model: 'model-b', isDefault: true },
      { id: 'alias-b', model: 'model-b', isDefault: false },
    ],
    usageModelScopes: { 'model-a:primary': 'model-a', 'alias-b:primary': 'model-b' },
    usage: {
      provider: 'CODEX',
      status: 'available',
      updatedAt: new Date().toISOString(),
      windows: [{ id: 'codex:primary', label: 'Global', usedPercent: 20, resetsAt: null }],
    },
  });
  const observations = new Map<string, AccountObservation>();
  const probe = vi.fn((context: CodexRuntimeContext) =>
    Promise.resolve(observations.get(context.homeDir) ?? makeObservation(context.accountId))
  );
  const login = vi.fn<NativeLogin>();
  const store = {
    list: async () => rows,
    get: async (id: string) => rows.find((row) => row.id === id) ?? null,
    create: (label: string) => {
      const row: AccountRow = {
        id: `managed-${rows.length}`,
        label,
        kind: 'MANAGED',
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
  const service = new CodexAccountService({
    store,
    config: {
      getBaseDir: () => base,
      getCodexHome: () => native,
      getCodexSessionsDir: () => join(native, 'sessions'),
      getChildProcessEnv: () => ({
        MODEL_PROVIDER: 'rogue',
        DEFAULT_AUTH_REQUEST: 'rogue',
        OPENAI_API_KEY: 'rogue',
      }),
    },
    probe,
    login,
  });
  return { service, probe, login, rows, base, native, observations, makeObservation, store };
}
it('stages reauthentication and preserves original credentials on wrong identity', async () => {
  const { service, login, base, observations, makeObservation } = await setup();
  const account = await service.createAccount('Bound');
  const home = join(base, 'codex-accounts', account.id);
  const original = '{"tokens":{"account_id":"original","access_token":"original-test-credential"}}';
  await writeFile(join(home, 'auth.json'), original);
  await service.getRuntimeContext(account.id);
  let finish!: () => void;
  login.mockImplementation(async (context) => {
    expect(context.homeDir).not.toBe(home);
    await writeFile(join(context.homeDir, 'auth.json'), '{"tokens":{"account_id":"replacement"}}');
    observations.set(context.homeDir, {
      ...makeObservation('replacement'),
      email: 'other@example.com',
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('login');
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(original);
  finish();
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('failed'));
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(original);
  expect((await service.getRuntimeContext(account.id)).accountId).toBe(account.id);
});
it('adopts successful staged credentials only after verified native process closure', async () => {
  const { service, login, base } = await setup();
  const account = await service.createAccount('New');
  const home = join(base, 'codex-accounts', account.id);
  login.mockImplementation(async (context) => {
    await writeFile(join(context.homeDir, 'auth.json'), '{"tokens":{"account_id":"verified"}}');
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('completed'));
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('verified');
});
it('blocks unsafe native-default browser re-login', async () => {
  const { service } = await setup();
  await expect(service.startLogin('codex-native-default')).rejects.toThrow('native Codex CLI');
});
it('scrubs adapter routing and authentication override variables', async () => {
  const { service } = await setup();
  const account = await service.createAccount('Managed');
  const context = await service.getRuntimeContext(account.id);
  expect(context.env.MODEL_PROVIDER).toBeUndefined();
  expect(context.env.DEFAULT_AUTH_REQUEST).toBeUndefined();
});
it('previews quota exhausted accounts and reuses cached observations', async () => {
  const { service, observations, native, makeObservation, probe } = await setup();
  const observation = makeObservation('default');
  observation.usage.windows[0]!.usedPercent = 100;
  observations.set(native, observation);
  await service.getAccounts();
  const calls = probe.mock.calls.length;
  expect((await service.getPreviewRuntimeContext()).accountId).toBe('codex-native-default');
  expect(probe.mock.calls.length).toBe(calls);
});
it('default model ignores unrelated exhausted model and explicit aliases match native quota scope', async () => {
  const { service, observations, native, makeObservation } = await setup();
  const observation = makeObservation('default');
  observation.usage.windows.push({
    id: 'model-a:primary',
    label: 'A',
    usedPercent: 100,
    resetsAt: null,
  });
  observations.set(native, observation);
  expect(await service.withAccountReservation({}, async (id) => id)).toBe('codex-native-default');
  observation.usage.windows.push({
    id: 'alias-b:primary',
    label: 'B',
    usedPercent: 100,
    resetsAt: null,
  });
  service.invalidate();
  await expect(
    service.withAccountReservation({ model: 'model-b' }, async (id) => id)
  ).rejects.toThrow('remaining capacity');
});
it('history resolves saved profile paths offline without probing or recreating a missing profile', async () => {
  const { service, probe, base } = await setup();
  const account = await service.createAccount('Offline');
  probe.mockRejectedValue(new Error('offline'));
  expect((await service.getHistoryContext(account.id)).accountId).toBe(account.id);
  expect(probe).not.toHaveBeenCalled();
  await rm(join(base, 'codex-accounts', account.id), { recursive: true, force: true });
  await expect(service.getHistoryContext(account.id)).rejects.toThrow();
});
it('cancellation covers asynchronous login preparation and prevents late native startup', async () => {
  const { service, login, probe } = await setup();
  const account = await service.createAccount('Preparing');
  let resolve!: (value: AccountObservation) => void;
  probe.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const started = service.startLogin(account.id);
  await vi.waitFor(() => expect(resolve).toBeDefined());
  const cancelled = service.cancelLogin(account.id);
  resolve({
    authenticated: false,
    scopeVerified: false,
    identityKey: null,
    email: null,
    planType: null,
    models: [],
    usage: {
      provider: 'CODEX',
      status: 'unavailable',
      updatedAt: new Date().toISOString(),
      windows: [],
    },
  });
  await Promise.allSettled([started, cancelled]);
  expect(login).not.toHaveBeenCalled();
  expect(service.getLoginStatus(account.id).status).toBe('cancelled');
});
it('allows distinct verified scopes and groups unknown native scope out of Auto', async () => {
  const { service, observations, native, makeObservation, base } = await setup();
  observations.set(native, { ...makeObservation('native-scope'), email: 'same@example.com' });
  await service.getAccounts();
  const one = await service.createAccount('One');
  const two = await service.createAccount('Two');
  observations.set(join(base, 'codex-accounts', one.id), {
    ...makeObservation('scope-one'),
    email: 'same@example.com',
  });
  observations.set(join(base, 'codex-accounts', two.id), {
    ...makeObservation('scope-two'),
    email: 'same@example.com',
  });
  expect((await service.getRuntimeContext(one.id)).accountId).toBe(one.id);
  expect((await service.getRuntimeContext(two.id)).accountId).toBe(two.id);
  const unknown = await setup();
  unknown.observations.set(unknown.native, {
    ...unknown.makeObservation('unknown'),
    identityKey: null,
    email: 'same@example.com',
  });
  await unknown.service.getAccounts();
  const managed = await unknown.service.createAccount('Unknown duplicate');
  unknown.observations.set(join(unknown.base, 'codex-accounts', managed.id), {
    ...unknown.makeObservation('managed-scope'),
    email: 'same@example.com',
  });
  expect((await unknown.service.getRuntimeContext(managed.id)).accountId).toBe(managed.id);
  expect(await unknown.service.withAccountReservation({}, async (id) => id)).toBe(managed.id);
});
it('does not hold the allocation queue while an unrelated native profile probe stalls', async () => {
  const { service, probe, rows, base, makeObservation, native } = await setup();
  const account = await service.createAccount('Ready');
  rows.find((row) => row.id === account.id)!.identityKey = account.id;
  let finish!: (value: AccountObservation) => void;
  probe.mockImplementation((context) =>
    context.homeDir === native
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(makeObservation(account.id))
  );
  const slow = service.withAccountReservation({}, async (id) => id);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await service.withAccountReservation({ accountId: account.id }, async (id) => id)).toBe(
    account.id
  );
  finish({ ...makeObservation('native'), authenticated: false });
  await slow;
  expect(await readFile(join(base, 'codex-accounts', account.id, 'config.toml'), 'utf8')).toContain(
    'file'
  );
});
it('does not count a tagged native-email fallback as an independently verified quota scope', async () => {
  const { service, observations, native, makeObservation, base } = await setup();
  observations.set(native, {
    ...makeObservation('native-email-fallback'),
    email: 'same@example.com',
    scopeVerified: false,
  });
  await service.getAccounts();
  const account = await service.createAccount('Scoped');
  observations.set(join(base, 'codex-accounts', account.id), {
    ...makeObservation('verified-scope'),
    email: 'same@example.com',
  });
  expect((await service.getRuntimeContext(account.id)).accountId).toBe(account.id);
  expect(await service.withAccountReservation({}, async (id) => id)).toBe(account.id);
});

it('upgrades a restored native-email tombstone only through matching-email staged login', async () => {
  const { service, rows, login, observations, makeObservation } = await setup();
  const account = await service.createAccount('Restored');
  const row = rows.find((item) => item.id === account.id)!;
  row.identityKey = `${nativeEmailFallbackKey('saved@example.com')}:imported:restore-one`;
  await expect(service.getRuntimeContext(account.id)).rejects.toThrow('identity');
  login.mockImplementation(async (context) => {
    await writeFile(join(context.homeDir, 'auth.json'), 'test-staged-auth');
    observations.set(context.homeDir, {
      ...makeObservation('provider-scope'),
      email: 'saved@example.com',
    });
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('completed'));
  expect(row.identityKey).toBe('provider-scope');
});
it('rejects a restored tombstone login with a different native verified email', async () => {
  const { service, rows, login, observations, makeObservation, base } = await setup();
  const account = await service.createAccount('Restored');
  const row = rows.find((item) => item.id === account.id)!;
  const original = nativeEmailFallbackKey('saved@example.com');
  row.identityKey = original;
  const home = join(base, 'codex-accounts', account.id);
  await writeFile(join(home, 'auth.json'), 'original-auth');
  login.mockImplementation(async (context) => {
    await writeFile(join(context.homeDir, 'auth.json'), 'replacement-auth');
    observations.set(context.homeDir, {
      ...makeObservation('wrong-scope'),
      email: 'other@example.com',
    });
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('failed'));
  expect(row.identityKey).toBe(original);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('original-auth');
});

it('does not replace original auth bytes when staged identity persistence fails', async () => {
  const { service, store, rows, login, observations, makeObservation, base } = await setup();
  const account = await service.createAccount('Restore');
  const row = rows.find((item) => item.id === account.id)!;
  row.identityKey = nativeEmailFallbackKey('saved@example.com');
  const home = join(base, 'codex-accounts', account.id);
  await writeFile(join(home, 'auth.json'), 'original-credentials');
  login.mockImplementation(async (context) => {
    await writeFile(join(context.homeDir, 'auth.json'), 'staged-credentials');
    observations.set(context.homeDir, {
      ...makeObservation('verified-scope'),
      email: 'saved@example.com',
    });
  });
  vi.spyOn(store, 'update').mockRejectedValue(new Error('injected DB persistence failure'));
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('failed'));
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('original-credentials');
});
it.each([true, false])(
  'prefers verified managed scope regardless of native-first observation order %s',
  async (nativeFirst) => {
    const { service, probe, rows, makeObservation, native } = await setup();
    const account = await service.createAccount('Bound');
    rows.find((row) => row.id === account.id)!.identityKey = 'managed-scope';
    probe.mockImplementation(async (context) => {
      const isNative = context.homeDir === native;
      await new Promise((resolve) => setTimeout(resolve, isNative === nativeFirst ? 0 : 20));
      return {
        ...makeObservation(isNative ? 'native-fallback' : 'managed-scope'),
        email: 'same@example.com',
        scopeVerified: !isNative,
      };
    });
    await service.getAccounts();
    expect(await service.withAccountReservation({}, async (id) => id)).toBe(account.id);
    expect((await service.getRuntimeContext(account.id)).accountId).toBe(account.id);
  }
);

it('retains conservative unknown native-scope rejection as an explicit staged enrollment policy', async () => {
  const { service, observations, native, makeObservation, login, rows } = await setup();
  observations.set(native, {
    ...makeObservation('native-fallback'),
    email: 'same@example.com',
    scopeVerified: false,
  });
  const account = await service.createAccount('New enrollment');
  login.mockImplementation(async (context) => {
    await writeFile(join(context.homeDir, 'auth.json'), 'new-auth');
    observations.set(context.homeDir, {
      ...makeObservation('verified-new'),
      email: 'same@example.com',
    });
  });
  await service.startLogin(account.id);
  await vi.waitFor(() => expect(service.getLoginStatus(account.id).status).toBe('failed'));
  expect(rows.find((row) => row.id === account.id)?.identityKey).toBeNull();
});

it('does not route around known exhausted managed quota through an overlapping unknown native scope', async () => {
  const { service, probe, rows, makeObservation, native } = await setup();
  const account = await service.createAccount('Bound');
  rows.find((row) => row.id === account.id)!.identityKey = 'managed-scope';
  probe.mockImplementation((context) => {
    const isNative = context.homeDir === native;
    const value = {
      ...makeObservation(isNative ? 'native-fallback' : 'managed-scope'),
      email: 'same@example.com',
      scopeVerified: !isNative,
    };
    value.usage = isNative
      ? { ...value.usage, status: 'unavailable', windows: [] }
      : {
          ...value.usage,
          windows: [{ id: 'codex:primary', label: 'Global', usedPercent: 100, resetsAt: null }],
        };
    return Promise.resolve(value);
  });
  await expect(service.withAccountReservation({}, async (id) => id)).rejects.toThrow(
    'remaining capacity'
  );
  expect((await service.getPreviewRuntimeContext()).accountId).toBe(account.id);
});
