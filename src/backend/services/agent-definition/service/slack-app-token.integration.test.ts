import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let service: import('./slack-connection.service').SlackConnectionService;
let crypto: typeof import('@/backend/services/crypto.service').cryptoService;
const botToken = 'xoxb-bot-secret';
const appToken = 'xapp-1-A0APP-123-app-secret';
const socketUrl = 'wss://wss-primary.slack.com/link/?ticket=socket-ticket-secret&app_id=A-app';
const request = vi.fn<typeof fetch>();
const slack = {
  team: 'T-company',
  botAppId: 'A-app',
  socketUrl,
  appResponse: undefined as unknown,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function route(url: string, init?: RequestInit) {
  const method = new URL(url).pathname.replace('/api/', '');
  if (method === 'auth.test') {
    return json({
      ok: true,
      team_id: slack.team,
      team: 'Company',
      user_id: 'U-bot',
      bot_id: 'B-bot',
    });
  }
  if (method === 'bots.info') {
    return json({
      ok: true,
      bot: { id: 'B-bot', deleted: false, name: 'factory', app_id: slack.botAppId },
    });
  }
  if (method === 'apps.connections.open') {
    expect(init?.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer x(?:oxe\.x)?app-/),
    });
    return json(slack.appResponse ?? { ok: true, url: slack.socketUrl });
  }
  throw new Error(`Unexpected Slack request ${method}`);
}
function calls(method: string) {
  return request.mock.calls.filter(([url]) => String(url).includes(`/api/${method}`));
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  vi.stubEnv('BASE_DIR', db.tempDir);
  ({ cryptoService: crypto } = await vi.importActual('@/backend/services/crypto.service'));
  const { SlackConnectionService } = await vi.importActual<
    typeof import('./slack-connection.service')
  >('./slack-connection.service');
  service = new SlackConnectionService(crypto, request);
}, 30_000);
beforeEach(() => {
  slack.team = 'T-company';
  slack.botAppId = 'A-app';
  slack.socketUrl = socketUrl;
  slack.appResponse = undefined;
  request.mockReset().mockImplementation((url, init) => Promise.resolve(route(String(url), init)));
});
afterEach(async () => {
  await db.prisma.agentConnection.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});

function connected() {
  return service.connect({ botToken });
}
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (reason: unknown) => reason
  );
  return error as Error & { code?: string };
}

it('stores a validated app token encrypted apart from the bot token and exposes only presence', async () => {
  const saved = await connected();
  expect(saved).toMatchObject({ hasAppToken: false, appId: null });
  const result = await service.setAppToken({ connectionId: saved.id, appToken: ` ${appToken} ` });
  expect(result).toEqual({
    id: saved.id,
    name: 'Company',
    workspaceId: 'T-company',
    isEnabled: true,
    hasCredentials: true,
    hasAppToken: true,
    appId: 'A-app',
  });
  const row = await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: saved.id } });
  expect(row.appCredentialsEncrypted).not.toContain(appToken);
  expect(row.appCredentialsEncrypted).not.toBe(row.credentialsEncrypted);
  expect(crypto.decrypt(row.appCredentialsEncrypted ?? '')).toBe(appToken);
  expect(crypto.decrypt(row.credentialsEncrypted ?? '')).toBe(botToken);
  expect(row.appId).toBe('A-app');

  expect(calls('bots.info')).toHaveLength(1);
  const [botsInfoUrl, botsInfoInit] = calls('bots.info')[0]!;
  expect(new URL(String(botsInfoUrl)).searchParams.get('bot')).toBe('B-bot');
  expect(botsInfoInit).toMatchObject({
    headers: { Authorization: `Bearer ${botToken}` },
    redirect: 'error',
  });
  expect(calls('apps.connections.open')).toEqual([
    [
      'https://slack.com/api/apps.connections.open',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: `Bearer ${appToken}` },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    ],
  ]);

  const outputs = [result, await service.list(), await service.test(saved.id)];
  for (const output of outputs) {
    const text = JSON.stringify(output);
    expect(text).not.toContain(appToken);
    expect(text).not.toContain(row.appCredentialsEncrypted);
    expect(text).not.toContain('socket-ticket-secret');
  }
  expect(await service.list()).toEqual([result]);
});

it('rejects an app token that Slack attributes to a different app', async () => {
  const saved = await connected();
  slack.socketUrl = 'wss://wss-primary.slack.com/link/?ticket=socket-ticket-secret&app_id=A-other';
  const error = await failure(service.setAppToken({ connectionId: saved.id, appToken }));
  expect(error).toMatchObject({ code: 'INVALID_INPUT' });
  expect(error.message).toContain('different Slack app');
  expect(error.message).not.toContain('socket-ticket-secret');
  expect(error.message).not.toContain('A-other');
  expect(await service.list()).toEqual([
    expect.objectContaining({ hasAppToken: false, appId: null }),
  ]);
});

it('rejects an app token when the saved bot token now identifies another workspace', async () => {
  const saved = await connected();
  slack.team = 'T-other';
  await expect(service.setAppToken({ connectionId: saved.id, appToken })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('different workspace'),
  });
  expect(calls('apps.connections.open')).toHaveLength(0);
  expect(await service.list()).toEqual([expect.objectContaining({ hasAppToken: false })]);
});

it('rejects bot and user tokens in the app-token field before any request', async () => {
  const saved = await connected();
  request.mockClear();
  for (const token of [
    botToken,
    'xoxe.xoxb-1-rotated-bot',
    'xoxp-user',
    'xapp',
    'xapp-',
    'XAPP-1-upper',
  ]) {
    await expect(
      service.setAppToken({ connectionId: saved.id, appToken: token })
    ).rejects.toMatchObject({
      name: 'ZodError',
      message: expect.stringContaining('Enter a Slack app-level token'),
    });
  }
  expect(request).not.toHaveBeenCalled();
});

it('accepts a rotating app-level access token', async () => {
  const saved = await connected();
  const rotating = 'xoxe.xapp-1-A0APP-123-rotating';
  expect(await service.setAppToken({ connectionId: saved.id, appToken: rotating })).toMatchObject({
    hasAppToken: true,
    appId: 'A-app',
  });
  expect(calls('apps.connections.open')[0]?.[1]).toMatchObject({
    headers: { Authorization: `Bearer ${rotating}` },
  });
  expect(await service.getAppCredentials(saved.id)).toMatchObject({ appToken: rotating });
});

it('reports an unreadable Slack body without blaming the network', async () => {
  const saved = await connected();
  request.mockImplementation((url, init) =>
    String(url).includes('apps.connections.open')
      ? Promise.resolve(new Response(`<html>${appToken}</html>`))
      : Promise.resolve(route(String(url), init))
  );
  const error = await failure(service.setAppToken({ connectionId: saved.id, appToken }));
  expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(error.message).toContain('unreadable response');
  expect(error.message).not.toContain(appToken);
});

it('sanitizes Slack app-token rejections and malformed responses', async () => {
  const saved = await connected();
  for (const [body, message] of [
    [{ ok: false, error: appToken }, 'Slack rejected this app-level token'],
    [{ ok: true, url: 'https://example.com/not-a-socket' }, 'Slack returned an invalid'],
    [{ ok: true }, 'Slack returned an invalid'],
  ] as const) {
    slack.appResponse = body;
    const error = await failure(service.setAppToken({ connectionId: saved.id, appToken }));
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(appToken);
  }
  request.mockImplementation((url) =>
    String(url).includes('apps.connections.open')
      ? Promise.reject(new Error(`Request failed for ${appToken}`))
      : Promise.resolve(route(String(url)))
  );
  const transport = await failure(service.setAppToken({ connectionId: saved.id, appToken }));
  expect(transport).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(transport.message).toContain('Could not reach Slack');
  expect(transport.message).not.toContain(appToken);
  expect(await db.prisma.agentConnection.count({ where: { appCredentialsEncrypted: null } })).toBe(
    1
  );
});

it('explains when the bot cannot read its own app identity', async () => {
  const saved = await connected();
  request.mockImplementation((url, init) =>
    String(url).includes('bots.info')
      ? Promise.resolve(json({ ok: false, error: 'missing_scope' }))
      : Promise.resolve(route(String(url), init))
  );
  await expect(service.setAppToken({ connectionId: saved.id, appToken })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('users:read'),
  });
  expect(calls('apps.connections.open')).toHaveLength(0);
});

it('requires a connected bot before accepting an app token', async () => {
  const saved = await connected();
  await service.disconnect(saved.id);
  await expect(service.setAppToken({ connectionId: saved.id, appToken })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(service.setAppToken({ connectionId: 'missing', appToken })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('does not save an app token over a bot credential that changed during validation', async () => {
  const saved = await connected();
  request.mockImplementation(async (url, init) => {
    if (String(url).includes('apps.connections.open')) {
      await db.prisma.agentConnection.update({
        where: { id: saved.id },
        data: { credentialsEncrypted: crypto.encrypt('xoxb-rotated') },
      });
    }
    return route(String(url), init);
  });
  await expect(service.setAppToken({ connectionId: saved.id, appToken })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(
    await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: saved.id } })
  ).toMatchObject({ appCredentialsEncrypted: null, appId: null });
});

it('disconnect clears both credentials and the app identity', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  await service.disconnect(saved.id);
  expect(
    await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: saved.id } })
  ).toMatchObject({
    credentialsEncrypted: null,
    appCredentialsEncrypted: null,
    appId: null,
    isEnabled: false,
  });
  expect(await service.getAppCredentials(saved.id)).toBeNull();
});

it('clears only the app token and keeps the bot connection', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  expect(await service.clearAppToken(saved.id)).toMatchObject({
    id: saved.id,
    hasCredentials: true,
    isEnabled: true,
    hasAppToken: false,
    appId: null,
  });
  expect(
    await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: saved.id } })
  ).toMatchObject({ appCredentialsEncrypted: null, appId: null });
  await expect(service.clearAppToken('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('returns decrypted app credentials only to the internal lookup', async () => {
  const saved = await connected();
  expect(await service.getAppCredentials(saved.id)).toBeNull();
  await service.setAppToken({ connectionId: saved.id, appToken });
  expect(await service.getAppCredentials(saved.id)).toEqual({
    connectionId: saved.id,
    workspaceId: 'T-company',
    appId: 'A-app',
    appToken,
  });
  await db.prisma.agentConnection.update({
    where: { id: saved.id },
    data: { appCredentialsEncrypted: 'not-ciphertext' },
  });
  const error = await failure(service.getAppCredentials(saved.id));
  expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(error.message).not.toContain('not-ciphertext');
});

it('tests the saved app token and its app identity along with the bot token', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  request.mockClear();
  expect(await service.test(saved.id)).toEqual({ valid: true, workspaceName: 'Company' });
  expect(calls('apps.connections.open')).toHaveLength(1);
  slack.botAppId = 'A-replaced';
  await expect(service.test(saved.id)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('different Slack app'),
  });
  slack.botAppId = 'A-app';
  slack.appResponse = { ok: false, error: 'token_revoked' };
  await expect(service.test(saved.id)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('app-level token'),
  });
});

it('keeps a saved app token when a replacement bot belongs to the same app', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  request.mockClear();
  expect(await service.connect({ botToken: 'xoxb-rotated' })).toMatchObject({
    id: saved.id,
    hasAppToken: true,
    appId: 'A-app',
  });
  expect(calls('bots.info')).toHaveLength(1);
  expect(calls('bots.info')[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer xoxb-rotated' },
  });
  expect(await service.getAppCredentials(saved.id)).toMatchObject({ appToken, appId: 'A-app' });
});

it('clears a saved app token when a replacement bot belongs to another app', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  slack.botAppId = 'A-other';
  expect(await service.connect({ botToken: 'xoxb-other-app' })).toMatchObject({
    id: saved.id,
    hasCredentials: true,
    hasAppToken: false,
    appId: null,
  });
  expect(await service.getAppCredentials(saved.id)).toBeNull();
});

it('clears a saved app token when the replacement bot app cannot be confirmed', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  request.mockImplementation((url, init) =>
    String(url).includes('bots.info')
      ? Promise.resolve(json({ ok: false, error: 'missing_scope' }))
      : Promise.resolve(route(String(url), init))
  );
  expect(await service.connect({ botToken: 'xoxb-no-scope' })).toMatchObject({
    hasCredentials: true,
    hasAppToken: false,
    appId: null,
  });
});

it('connects a bot without an app lookup when no app token is saved', async () => {
  await connected();
  expect(calls('bots.info')).toHaveLength(0);
});

it('does not bring back an app token removed while a reconnect was validating', async () => {
  const saved = await connected();
  await service.setAppToken({ connectionId: saved.id, appToken });
  for (const remove of [
    () => service.disconnect(saved.id),
    () => service.clearAppToken(saved.id),
  ]) {
    request.mockImplementation(async (url, init) => {
      if (String(url).includes('bots.info')) {
        await remove();
      }
      return route(String(url), init);
    });
    // The replacement bot's app matches the app ID read before the removal.
    expect(await service.connect({ botToken: 'xoxb-reconnect' })).toMatchObject({
      hasCredentials: true,
      hasAppToken: false,
      appId: null,
    });
    expect(await service.getAppCredentials(saved.id)).toBeNull();
    request.mockImplementation((url, init) => Promise.resolve(route(String(url), init)));
    await service.setAppToken({ connectionId: saved.id, appToken });
  }
});
