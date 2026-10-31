import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let service: import('./slack-connection.service').SlackConnectionService;
let crypto: typeof import('@/backend/services/crypto.service').cryptoService;
const token = 'xoxb-test-secret';
const response = (teamId = 'T-company') =>
  new Response(
    JSON.stringify({
      ok: true,
      team_id: teamId,
      team: 'Company',
      user_id: 'U-bot',
      bot_id: 'B-bot',
    })
  );
const request = vi.fn<typeof fetch>();

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
  request.mockReset().mockImplementation(async () => response());
});
afterEach(async () => {
  await db.prisma.agentConnection.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});

it('encrypts validated credentials and exposes only safe workspace metadata', async () => {
  const saved = await service.connect({ botToken: token });
  expect(saved).toMatchObject({ name: 'Company', workspaceId: 'T-company', hasCredentials: true });
  const row = await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: saved.id } });
  expect(row.credentialsEncrypted).not.toContain(token);
  expect(crypto.decrypt(row.credentialsEncrypted ?? '')).toBe(token);
  expect(JSON.stringify(await service.list())).not.toContain(token);
  expect(JSON.stringify(await service.list())).not.toContain(row.credentialsEncrypted);
  expect(request).toHaveBeenCalledWith(
    'https://slack.com/api/auth.test',
    expect.objectContaining({
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    })
  );
});

it('discovers paginated channels without exposing tokens and rejects inaccessible channels', async () => {
  const saved = await service.connect({ botToken: token });
  request.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        channels: [
          { id: 'C-feedback', name: 'customer-feedback', is_member: true, is_archived: false },
          { id: 'C-other', name: 'other', is_member: false, is_archived: false },
        ],
        response_metadata: { next_cursor: 'page-two' },
      })
    )
  );
  const page = await service.channels(saved.id);
  expect(page).toEqual({
    channels: [{ id: 'C-feedback', name: 'customer-feedback' }],
    nextCursor: 'page-two',
  });
  expect(JSON.stringify(page)).not.toContain(token);
  request.mockImplementationOnce((url) => {
    expect(new URL(String(url)).searchParams.get('cursor')).toBe('page-two');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          channels: [{ id: 'C-next', name: 'next-page', is_member: true, is_archived: false }],
          response_metadata: { next_cursor: '' },
        })
      )
    );
  });
  expect(await service.channels(saved.id, page.nextCursor ?? undefined)).toEqual({
    channels: [{ id: 'C-next', name: 'next-page' }],
    nextCursor: null,
  });
  request.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        channel: {
          id: 'C-other',
          name: 'other',
          is_member: false,
          is_archived: false,
        },
      })
    )
  );
  await expect(service.channel(saved.id, 'C-other')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

it('sanitizes Slack source failures and refuses disconnected connections', async () => {
  const saved = await service.connect({ botToken: token });
  request.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: token })));
  const failure = service.channels(saved.id);
  await expect(failure).rejects.toThrow('Could not read Slack channels');
  await expect(failure).rejects.not.toThrow(token);
  await service.disconnect(saved.id);
  await expect(service.channels(saved.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

it('reconnects one workspace without creating duplicate connection rows', async () => {
  const first = await service.connect({ botToken: token });
  const second = await service.connect({ botToken: 'xoxb-replacement' });
  expect(second.id).toBe(first.id);
  expect(await db.prisma.agentConnection.count()).toBe(1);
});

it('exposes no ciphertext from the list accessor', async () => {
  const saved = await service.connect({ botToken: token });
  const { slackConnectionAccessor } = await vi.importActual<
    typeof import('@/backend/services/agent-definition/resources/slack-connection.accessor')
  >('@/backend/services/agent-definition/resources/slack-connection.accessor');
  expect(await slackConnectionAccessor.list()).toEqual([saved]);
});

it('does not persist tokens Slack rejects and never echoes untrusted errors', async () => {
  request.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: token })));
  await expect(service.connect({ botToken: token })).rejects.toThrow(
    'Slack rejected this bot token'
  );
  expect(await db.prisma.agentConnection.count()).toBe(0);
});

it('rejects non-bot responses and malformed Slack data', async () => {
  request.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, team_id: 'T-company', team: 'Company' }))
  );
  await expect(service.connect({ botToken: token })).rejects.toThrow(
    'Slack returned an invalid bot identity'
  );
  expect(await db.prisma.agentConnection.count()).toBe(0);
});

it('tests stored credentials and disconnects without deleting the connection', async () => {
  const saved = await service.connect({ botToken: token });
  expect(await service.test(saved.id)).toEqual({ valid: true, workspaceName: 'Company' });
  await service.disconnect(saved.id);
  expect(await service.list()).toEqual([
    expect.objectContaining({ id: saved.id, hasCredentials: false, isEnabled: false }),
  ]);
  await expect(service.test(saved.id)).rejects.toThrow('No Slack credentials are saved');
});

it('does not accept a saved credential that now identifies another workspace', async () => {
  const saved = await service.connect({ botToken: token });
  request.mockImplementation(async () => response('T-other'));
  await expect(service.test(saved.id)).rejects.toThrow('different workspace');
});

it('sanitizes transport failures that might contain credentials', async () => {
  request.mockRejectedValue(new Error(`Request failed for ${token}`));
  await expect(service.connect({ botToken: token })).rejects.toThrow('Could not reach Slack');
});

it('rejects user tokens before sending a request', async () => {
  await expect(service.connect({ botToken: 'xoxp-user-secret' })).rejects.toThrow(
    'Enter a Slack bot token'
  );
  expect(request).not.toHaveBeenCalled();
  expect(await db.prisma.agentConnection.count()).toBe(0);
});

it('accepts rotated bot access tokens', async () => {
  expect(await service.connect({ botToken: 'xoxe.xoxb-1-test-token' })).toMatchObject({
    hasCredentials: true,
  });
});

it('treats rejected saved tokens as a failed precondition', async () => {
  const saved = await service.connect({ botToken: token });
  request.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'token_revoked' })));
  await expect(service.test(saved.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

it('sanitizes a dropped response body as a transport failure', async () => {
  request.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(token));
        },
      })
    )
  );
  await expect(service.connect({ botToken: token })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('Could not reach Slack'),
  });
});

it('reports rate limiting even when Slack returns a non-JSON response', async () => {
  request.mockResolvedValue(new Response('Too many requests', { status: 429 }));
  await expect(service.connect({ botToken: token })).rejects.toThrow('rate limiting');
});
