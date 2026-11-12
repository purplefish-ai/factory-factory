import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentSourceCursorSchema, agentSourceHealthSchema } from '@/shared/agent-runtime';
import type { SlackSocketHandlers } from './slack-event-source';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let connectionId: string;
let definitionId: string;
let sockets: FakeSocket[];
let credentials: { appToken: string; appId: string; workspaceId: string } | null;
let enabled: boolean;
let ingest: typeof import('../index').ingestEvent;
let source: import('./slack-event-source').SlackEventSource;
const signal = new AbortController().signal;

type Envelope = Parameters<SlackSocketHandlers['onEnvelope']>[0];

class FakeSocket {
  readonly acks: string[] = [];
  disconnects = 0;
  private resolveStart!: () => void;
  private rejectStart!: (error: unknown) => void;
  readonly started = new Promise<void>((resolve, reject) => {
    this.resolveStart = resolve;
    this.rejectStart = reject;
  });
  constructor(
    readonly token: string,
    readonly handlers: SlackSocketHandlers,
    private readonly autoHello: string | null
  ) {}
  start() {
    if (this.autoHello) {
      this.hello(this.autoHello);
    }
    return this.started;
  }
  hello(appId: string) {
    this.handlers.onHello({
      type: 'hello',
      num_connections: 1,
      connection_info: { app_id: appId },
    });
    this.resolveStart();
  }
  fail(error: unknown) {
    this.rejectStart(error);
  }
  /** Like the SDK during `apps.connections.open`, disconnecting does not settle a pending start. */
  disconnect() {
    this.disconnects++;
    return Promise.resolve();
  }
  drop() {
    this.handlers.onDisconnected();
  }
  async deliver(envelope: Omit<Envelope, 'ack'> & { id?: string }) {
    const id = envelope.id ?? crypto.randomUUID();
    await this.handlers.onEnvelope({
      type: envelope.type,
      body: envelope.body,
      ack: () => {
        this.acks.push(id);
        return Promise.resolve();
      },
    });
    return id;
  }
}

let autoHello: string | null;
function createSource(options: { connectTimeoutMs?: number } = {}) {
  return new runtime.SlackEventSource({
    createSocket: (appToken, handlers) => {
      const socket = new FakeSocket(appToken, handlers, autoHello);
      sockets.push(socket);
      return socket;
    },
    getAppCredentials: (id) =>
      Promise.resolve(credentials ? { connectionId: id, ...credentials } : null),
    isEnabled: () => enabled,
    ingestEvent: (input) => ingest(input),
    ...options,
  });
}

function message(overrides: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) {
  return {
    type: 'events_api',
    body: {
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: `Ev-${crypto.randomUUID()}`,
      event_time: 1_700_000_000,
      event: {
        type: 'message',
        channel: 'C1',
        user: 'U-human',
        text: 'Please investigate the outage',
        ts: '1700000000.000100',
        ...overrides,
      },
      ...outer,
    },
  };
}

async function sourceState() {
  const row = await db.prisma.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
  const cursor = agentSourceCursorSchema.parse(row.cursor);
  if (cursor.provider !== 'SLACK') {
    throw new Error('Expected a Slack cursor');
  }
  return { isReady: row.isReady, health: agentSourceHealthSchema.parse(row.health), cursor };
}

async function connected() {
  await source.reconcileConnections(signal);
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error('No socket was opened');
  }
  return socket;
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.project.deleteMany();
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: crypto.randomUUID(),
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId: project.id, name: 'Responder', instructions: 'Help', isEnabled: true },
  });
  definitionId = definition.id;
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'SLACK', externalId: 'T1', name: 'Company', credentialsEncrypted: 'x' },
  });
  connectionId = connection.id;
  await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definitionId,
      connectionId,
      type: 'SLACK_MESSAGE',
      description: 'Messages in #support',
      config: { version: 1, channelIds: ['C1'] },
      isEnabled: true,
      isConfigured: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
    },
  });
  sockets = [];
  autoHello = 'A1';
  enabled = true;
  credentials = { appToken: 'xapp-1-A1-1-secret', appId: 'A1', workspaceId: 'T1' };
  ingest = runtime.ingestEvent;
  source = createSource();
  source.start();
});
afterEach(async () => {
  await source.stop();
});

it('stores a human root message and a thread reply before acknowledging them', async () => {
  const socket = await connected();
  expect(socket.token).toBe('xapp-1-A1-1-secret');
  const rowsAtAck: number[] = [];
  const handlers = socket.handlers;
  const root = message();
  const reply = message({ ts: '1700000001.000200', thread_ts: '1700000000.000100' });
  for (const envelope of [root, reply]) {
    await handlers.onEnvelope({
      ...envelope,
      ack: async () => {
        rowsAtAck.push(await db.prisma.agentEvent.count());
      },
    });
  }
  expect(rowsAtAck).toEqual([1, 2]);
  const events = await db.prisma.agentEvent.findMany({ orderBy: { occurredAt: 'asc' } });
  expect(events.map((event) => event.providerEventId)).toEqual([
    root.body.event_id,
    reply.body.event_id,
  ]);
  expect(events[1]?.payload).toMatchObject({
    provider: 'SLACK',
    workspaceId: 'T1',
    appId: 'A1',
    channelId: 'C1',
    action: 'message',
    actorType: 'HUMAN',
    actorId: 'U-human',
    subtype: null,
    eventTs: '1700000001.000200',
    threadTs: '1700000000.000100',
    occurredAt: '2023-11-14T22:13:21.000Z',
    sourceUrl: 'https://slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.000100&cid=C1',
  });
  expect((await sourceState()).health.state).toBe('READY');
  expect((await sourceState()).isReady).toBe(true);
});

it('leaves a message unacknowledged when its insert fails, then acknowledges the redelivery', async () => {
  const socket = await connected();
  ingest = () => Promise.reject(new Error('database is locked'));
  const envelope = message();
  await socket.deliver({ ...envelope, id: 'first' });
  expect(socket.acks).toEqual([]);
  expect(await db.prisma.agentEvent.count()).toBe(0);
  ingest = runtime.ingestEvent;
  await socket.deliver({ ...envelope, id: 'retry' });
  expect(socket.acks).toEqual(['retry']);
  expect(await db.prisma.agentEvent.count()).toBe(1);
});

it('acknowledges a duplicate delivery without storing a second row', async () => {
  const socket = await connected();
  const envelope = message();
  await socket.deliver({ ...envelope, id: 'one' });
  await socket.deliver({ ...envelope, id: 'two' });
  expect(socket.acks).toEqual(['one', 'two']);
  expect(await db.prisma.agentEvent.count()).toBe(1);
});

it('acknowledges bot, edited, deleted and subtype messages and unsupported envelopes without storing them', async () => {
  const socket = await connected();
  const ignored = [
    message({ bot_id: 'B1' }),
    message({ subtype: 'bot_message', bot_id: 'B1' }),
    message({ subtype: 'message_changed', message: { text: 'edited secret' } }),
    message({ subtype: 'message_deleted', deleted_ts: '1700000000.000100' }),
    message({ subtype: 'channel_join' }),
    message({ subtype: 'file_share', bot_id: 'B1' }),
    message({ type: 'reaction_added' }),
    message({ user: undefined }),
    { type: 'slash_commands', body: { command: '/deploy', text: 'secret' } },
    { type: 'interactive', body: { type: 'block_actions' } },
  ];
  for (const envelope of ignored) {
    await socket.deliver(envelope);
  }
  expect(socket.acks).toHaveLength(ignored.length);
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it("stores a person's file share and thread broadcast as text-only messages", async () => {
  const socket = await connected();
  await socket.deliver(
    message({ subtype: 'file_share', files: [{ id: 'F1', name: 'screen.png' }], text: 'See this' })
  );
  await socket.deliver(
    message({
      subtype: 'thread_broadcast',
      ts: '1700000002.000300',
      thread_ts: '1700000000.000100',
      text: 'Also posting here',
    })
  );
  expect(socket.acks).toHaveLength(2);
  const events = await db.prisma.agentEvent.findMany({ orderBy: { occurredAt: 'asc' } });
  expect(events.map((event) => event.payload)).toEqual([
    expect.objectContaining({ subtype: 'file_share', actorType: 'HUMAN', text: 'See this' }),
    expect.objectContaining({
      subtype: 'thread_broadcast',
      actorType: 'HUMAN',
      threadTs: '1700000000.000100',
      text: 'Also posting here',
    }),
  ]);
  expect(events[0]?.payload).not.toHaveProperty('files');
  expect(JSON.stringify(events[0]?.payload)).not.toContain('screen.png');
});

it('acknowledges messages in channels no listening trigger selects without storing them', async () => {
  const socket = await connected();
  await socket.deliver(message({ channel: 'C-other' }));
  expect(socket.acks).toHaveLength(1);
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it.each([
  ['team', { team_id: 'T-other' }, 'SLACK_WORKSPACE_MISMATCH'],
  ['app', { api_app_id: 'A-other' }, 'SLACK_APP_MISMATCH'],
  ['missing identity', { api_app_id: undefined }, 'SLACK_APP_MISMATCH'],
])(
  'rejects an event for the wrong %s as source health and stops listening',
  async (_name, outer, reason) => {
    const socket = await connected();
    await socket.deliver(message({}, outer));
    expect(socket.acks).toEqual([]);
    expect(await db.prisma.agentEvent.count()).toBe(0);
    expect(socket.disconnects).toBe(1);
    const state = await sourceState();
    expect(state.health).toMatchObject({ state: 'ERROR', reasonCode: reason });
    expect(state.isReady).toBe(false);
    expect(state.cursor.gaps).toEqual([{ from: expect.any(String), to: null }]);
    // The same credentials are not retried; replacing them is.
    await source.reconcileConnections(signal);
    expect(sockets).toHaveLength(1);
    credentials = { appToken: 'xapp-1-A1-2-replaced', appId: 'A1', workspaceId: 'T1' };
    await source.reconcileConnections(signal);
    expect(sockets).toHaveLength(2);
  }
);

it('refuses a socket whose hello names another app', async () => {
  autoHello = null;
  const pending = source.reconcileConnections(signal);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0] as FakeSocket;
  socket.hello('A-other');
  await pending;
  expect(socket.disconnects).toBe(1);
  expect((await sourceState()).health).toMatchObject({
    state: 'ERROR',
    reasonCode: 'SLACK_APP_MISMATCH',
  });
  await socket.deliver(message());
  expect(socket.acks).toEqual([]);
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('refuses a hello without connection info', async () => {
  autoHello = null;
  const pending = source.reconcileConnections(signal);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0] as FakeSocket;
  socket.handlers.onHello({ type: 'hello', num_connections: 1 });
  socket.hello('A1');
  await pending;
  expect(socket.disconnects).toBe(1);
  expect((await sourceState()).health.reasonCode).toBe('SLACK_APP_MISMATCH');
});

it('bounds an oversized message', async () => {
  const socket = await connected();
  await socket.deliver(message({ text: 'x'.repeat(150_000) }));
  const [event] = await db.prisma.agentEvent.findMany();
  const payload = event?.payload as { text: string };
  expect(payload.text.length).toBeLessThanOrEqual(100_000);
  expect(payload.text.endsWith('[Message truncated by Factory Factory]')).toBe(true);
  expect(socket.acks).toHaveLength(1);
});

it('acknowledges malformed messages without storing them', async () => {
  const socket = await connected();
  await socket.deliver(message({ ts: 'not-a-timestamp' }));
  await socket.deliver(message({ channel: 'C'.repeat(300) }));
  await socket.deliver(message({}, { event_id: '' }));
  expect(socket.acks).toHaveLength(3);
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('records a delivery gap on disconnect and closes it when the listener reconnects', async () => {
  const socket = await connected();
  socket.drop();
  await vi.waitFor(async () => expect((await sourceState()).health.state).toBe('DISCONNECTED'));
  const dropped = await sourceState();
  expect(dropped).toMatchObject({
    isReady: false,
    health: { reasonCode: 'SLACK_DISCONNECTED' },
    cursor: { gaps: [{ from: expect.any(String), to: null }] },
  });
  // Events on the dropped socket are not acknowledged, so Slack can redeliver them.
  await socket.deliver(message());
  expect(socket.acks).toEqual([]);
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(2);
  const resumed = await sourceState();
  expect(resumed.health.state).toBe('READY');
  expect(resumed.cursor.gaps).toEqual([{ from: expect.any(String), to: expect.any(String) }]);
});

it('treats a socket that closes before hello as a failed attempt and backs off', async () => {
  autoHello = null;
  const pending = source.reconcileConnections(signal);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0] as FakeSocket;
  socket.drop();
  socket.fail(new Error('socket closed'));
  await pending;
  expect((await sourceState()).health).toMatchObject({
    state: 'ERROR',
    reasonCode: 'SLACK_CONNECT_FAILED',
  });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(1);
});

it('reconnects exactly once when the app-level token is rotated', async () => {
  const first = await connected();
  credentials = { appToken: 'xapp-1-A1-2-rotated', appId: 'A1', workspaceId: 'T1' };
  await source.reconcileConnections(signal);
  await source.reconcileConnections(signal);
  expect(sockets.map((socket) => socket.token)).toEqual([
    'xapp-1-A1-1-secret',
    'xapp-1-A1-2-rotated',
  ]);
  expect(first.disconnects).toBe(1);
  expect(sockets[1]?.disconnects).toBe(0);
  await first.deliver(message());
  expect(first.acks).toEqual([]);
});

it('leaves one live socket when a stalled connection attempt completes after its replacement', async () => {
  source = createSource({ connectTimeoutMs: 20 });
  source.start();
  autoHello = null;
  await source.reconcileConnections(signal);
  const stalled = sockets[0] as FakeSocket;
  expect(stalled.disconnects).toBe(1);
  expect((await sourceState()).health).toMatchObject({
    state: 'ERROR',
    reasonCode: 'SLACK_CONNECT_TIMEOUT',
  });
  autoHello = 'A1';
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(1);
  // Retry waits out the backoff after a failed attempt.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  await source.reconcileConnections(signal);
  vi.useRealTimers();
  expect(sockets).toHaveLength(2);
  // The stalled attempt finally says hello: it is closed and its events are left for redelivery.
  stalled.hello('A1');
  await stalled.deliver(message());
  expect(stalled.acks).toEqual([]);
  const live = sockets[1] as FakeSocket;
  await live.deliver(message());
  expect(live.acks).toHaveLength(1);
  expect(live.disconnects).toBe(0);
  expect((await sourceState()).health.state).toBe('READY');
});

it('closes a socket whose connection attempt finishes after stop', async () => {
  autoHello = null;
  const pending = source.reconcileConnections(signal);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  await source.stop();
  const socket = sockets[0] as FakeSocket;
  expect(socket.disconnects).toBe(1);
  // The attempt completes only now, after stop.
  socket.hello('A1');
  await pending;
  await socket.deliver(message());
  expect(socket.acks).toEqual([]);
  expect(await db.prisma.agentEvent.count()).toBe(0);
  expect((await sourceState()).health).toMatchObject({
    state: 'DISCONNECTED',
    reasonCode: 'SLACK_LISTENER_STOPPED',
  });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(1);
});

it('does not connect when every listening trigger has malformed configuration', async () => {
  await db.prisma.agentTrigger.updateMany({ data: { config: { version: 1, channelIds: [] } } });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(0);
});

it('opens no connection while the intake gate is off, and closes one when it turns off', async () => {
  enabled = false;
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(0);
  enabled = true;
  const socket = await connected();
  socket.drop();
  await vi.waitFor(async () => expect((await sourceState()).cursor.gaps).toHaveLength(1));
  await source.reconcileConnections(signal);
  enabled = false;
  await source.reconcileConnections(signal);
  expect(sockets[1]?.disconnects).toBe(1);
  const state = await sourceState();
  expect(state.health).toMatchObject({
    state: 'DISCONNECTED',
    reasonCode: 'SLACK_INTAKE_DISABLED',
  });
  expect(state.cursor.gaps.every((gap) => gap.to !== null)).toBe(true);
});

it('connects only for connections with an app token and a listening trigger', async () => {
  credentials = null;
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(0);
  expect((await sourceState()).health.reasonCode).toBe('SLACK_APP_TOKEN_MISSING');
  credentials = { appToken: 'xapp-1-A1-1-secret', appId: 'A1', workspaceId: 'T1' };
  await db.prisma.agentTrigger.updateMany({ data: { activationState: 'PAUSED' } });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(0);
  await db.prisma.agentTrigger.updateMany({ data: { activationState: 'STARTING' } });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(1);
  await db.prisma.agentTrigger.updateMany({ data: { isConfigured: false } });
  await source.reconcileConnections(signal);
  expect(sockets[0]?.disconnects).toBe(1);
  expect((await sourceState()).health.reasonCode).toBe('SLACK_NOT_LISTENING');
});

it('refuses to listen when two connections share one Slack app', async () => {
  const other = await db.prisma.agentConnection.create({
    data: { provider: 'SLACK', externalId: 'T2', name: 'Other', credentialsEncrypted: 'x' },
  });
  await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definitionId,
      connectionId: other.id,
      type: 'SLACK_MESSAGE',
      description: 'Other workspace',
      config: { version: 1, channelIds: ['C9'] },
      isEnabled: true,
      isConfigured: true,
      activationState: 'ACTIVE',
    },
  });
  await source.reconcileConnections(signal);
  expect(sockets).toHaveLength(0);
  expect((await sourceState()).health.reasonCode).toBe('SLACK_APP_SHARED');
});

it('records a gap when stopped and after an unclean exit of a previous process', async () => {
  await connected();
  await source.stop();
  expect(await sourceState()).toMatchObject({
    isReady: false,
    health: { state: 'DISCONNECTED', reasonCode: 'SLACK_LISTENER_STOPPED' },
    cursor: { gaps: [{ to: null }] },
  });
  // A previous process left READY behind without recording its exit.
  const lastSeen = new Date('2026-11-01T00:00:00.000Z');
  await db.prisma.agentSourceState.update({
    where: { connectionId },
    data: {
      health: { state: 'READY', reasonCode: null, updatedAt: lastSeen.toISOString() },
      cursor: { version: 1, provider: 'SLACK', gaps: [] },
      isReady: true,
      lastObservedAt: lastSeen,
    },
  });
  source = createSource();
  source.start();
  enabled = false;
  await source.reconcileConnections(signal);
  expect(await sourceState()).toMatchObject({
    isReady: false,
    health: { state: 'DISCONNECTED', reasonCode: 'SLACK_LISTENER_STOPPED' },
    cursor: { gaps: [{ from: lastSeen.toISOString(), to: null }] },
  });
  enabled = true;
  await source.reconcileConnections(signal);
  expect((await sourceState()).cursor.gaps).toEqual([
    { from: lastSeen.toISOString(), to: expect.any(String) },
  ]);
});
