import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SlackSocketHandlers } from '@/backend/services/agent-definition';
import { createSlackSocket } from './slack-socket';

const logs = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/backend/services/logger.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backend/services/logger.service')>()),
  createLogger: () => ({
    debug: (...args: unknown[]) => logs.push(args),
    info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => logs.push(args),
  }),
}));

const APP_TOKEN = 'xapp-1-A1-1-app-token-secret';
const TICKET = 'socket-ticket-secret';
const BODY = 'Message body that must never be logged';
let server: WebSocketServer;
let socketUrl: string;
let received: string[];
let peers: WebSocket[];
let consoleOutput: unknown[][];
let onConnection: (peer: WebSocket) => void;

function hello(appId = 'A1') {
  return JSON.stringify({
    type: 'hello',
    num_connections: 1,
    debug_info: { host: 'applink-test', approximate_connection_time: 18_060 },
    connection_info: { app_id: appId },
  });
}
const envelope = JSON.stringify({
  envelope_id: 'envelope-1',
  type: 'events_api',
  accepts_response_payload: false,
  retry_attempt: 0,
  retry_reason: '',
  payload: {
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: 'Ev1',
    event: { type: 'message', channel: 'C1', user: 'U1', text: BODY, ts: '1.2' },
  },
});

function slackApi(response: unknown = { ok: true, url: socketUrl }) {
  return vi.fn<typeof fetch>((_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${APP_TOKEN}`);
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  });
}

function recorder() {
  const events: string[] = [];
  const hellos: unknown[] = [];
  const envelopes: Array<{ type: string; body: unknown }> = [];
  let ack: (() => Promise<void>) | undefined;
  const handlers: SlackSocketHandlers = {
    onHello: (message) => {
      events.push('hello');
      hellos.push(message);
    },
    onEnvelope: (value) => {
      events.push('envelope');
      envelopes.push({ type: value.type, body: value.body });
      ack = value.ack;
      return Promise.resolve();
    },
    onDisconnected: () => {
      events.push('disconnected');
    },
  };
  return { handlers, events, hellos, envelopes, ack: () => ack?.() };
}

beforeEach(async () => {
  logs.length = 0;
  received = [];
  peers = [];
  consoleOutput = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args);
    });
  }
  onConnection = (peer) => {
    peer.send(hello());
    peer.send(envelope);
  };
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('message', (data) => received.push(String(data)));
    onConnection(peer);
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  socketUrl = `ws://127.0.0.1:${port}/link/?ticket=${TICKET}&app_id=A1`;
});

afterEach(async () => {
  for (const peer of peers) {
    peer.terminate();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Nothing the SDK wrote may contain the token, the socket ticket URL or a message body.
  const output = JSON.stringify([logs, consoleOutput]);
  expect(output).not.toContain(APP_TOKEN);
  expect(output).not.toContain(TICKET);
  expect(output).not.toContain('/link/');
  expect(output).not.toContain(BODY);
  vi.restoreAllMocks();
});

it('passes the hello frame through and acknowledges only when the listener does', async () => {
  const { handlers, events, hellos, envelopes, ack } = recorder();
  const socket = createSlackSocket(APP_TOKEN, handlers, { fetch: slackApi() });
  await socket.start();
  await vi.waitFor(() => expect(envelopes).toHaveLength(1));
  expect(hellos).toEqual([expect.objectContaining({ connection_info: { app_id: 'A1' } })]);
  expect(envelopes[0]).toMatchObject({ type: 'events_api', body: { event_id: 'Ev1' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toEqual([]);
  await ack();
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(JSON.parse(received[0] ?? '')).toEqual({ envelope_id: 'envelope-1', payload: {} });
  await socket.disconnect();
  expect(events).toEqual(['hello', 'envelope']);
});

it('reports a server-side close as a disconnect without reconnecting', async () => {
  const { handlers, events } = recorder();
  const fetch = slackApi();
  const socket = createSlackSocket(APP_TOKEN, handlers, { fetch });
  await socket.start();
  peers[0]?.close(1001, 'refresh_requested');
  await vi.waitFor(() => expect(events).toContain('disconnected'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fetch).toHaveBeenCalledOnce();
  expect(peers).toHaveLength(1);
  await socket.disconnect();
});

it('rejects start without retrying when Slack refuses the app-level token', async () => {
  const { handlers, events } = recorder();
  const fetch = slackApi({ ok: false, error: 'invalid_auth' });
  const socket = createSlackSocket(APP_TOKEN, handlers, { fetch });
  await expect(socket.start()).rejects.toMatchObject({ data: { error: 'invalid_auth' } });
  expect(fetch).toHaveBeenCalledOnce();
  expect(peers).toHaveLength(0);
  expect(events).toEqual([]);
});

it('rejects start without retrying when Slack is unreachable', async () => {
  const { handlers } = recorder();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error(`connect failed ${socketUrl}`))
  );
  const socket = createSlackSocket(APP_TOKEN, handlers, { fetch });
  await expect(socket.start()).rejects.toBeDefined();
  expect(fetch).toHaveBeenCalledOnce();
});

it('closes a socket that finishes connecting after it was disconnected', async () => {
  const { handlers, events } = recorder();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const respond = slackApi();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    await gate;
    return await respond(url, init);
  });
  const socket = createSlackSocket(APP_TOKEN, handlers, { fetch });
  const started = socket.start().catch(() => undefined);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await socket.disconnect();
  release();
  await started;
  await vi.waitFor(() => expect(peers).toHaveLength(1));
  await vi.waitFor(() => expect(peers[0]?.readyState).toBe(3));
  expect(received).toEqual([]);
  expect(events).toEqual([]);
});
