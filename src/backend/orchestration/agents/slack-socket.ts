import { type Logger, LogLevel, SocketModeClient } from '@slack/socket-mode';
import { z } from 'zod';
import type { SlackSocket, SlackSocketHandlers } from '@/backend/services/agent-definition';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('slack-socket');
const HELLO_MAX_LENGTH = 10_000;
const helloSchema = z.object({ type: z.literal('hello') });
const envelopeSchema = z.object({ type: z.string(), envelope_id: z.string() });

/** SDK messages can carry the token header, the ticketed socket URL or raw frames; keep only a category. */
const SDK_LOG_CATEGORIES: [string, string][] = [
  ['Failed to retrieve a new WSS URL', 'CONNECTION_OPEN_FAILED'],
  ['http request failed', 'HTTP_REQUEST_FAILED'],
  ['WebSocket error', 'WEBSOCKET_ERROR'],
  ["A ping wasn't received", 'SERVER_PING_TIMEOUT'],
  ["A pong wasn't received", 'CLIENT_PONG_TIMEOUT'],
  ['Failed to send', 'SEND_FAILED'],
  ['Peer did not complete the close handshake', 'CLOSE_HANDSHAKE_TIMEOUT'],
];

function category(messages: unknown[]) {
  const [first] = messages;
  const text = typeof first === 'string' ? first : '';
  return SDK_LOG_CATEGORIES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? 'SDK_MESSAGE';
}

const sdkLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...messages) =>
    logger.warn('Slack Socket Mode client warning.', { reason: category(messages) }),
  error: (...messages) =>
    logger.error('Slack Socket Mode client error.', { reason: category(messages) }),
  setLevel: () => undefined,
  // Above DEBUG, so the SDK never serializes frames or acknowledgements for logging.
  getLevel: () => LogLevel.INFO,
  setName: () => undefined,
};

/**
 * One official Socket Mode client per connection attempt. The client neither
 * retries nor reconnects on its own: its reconnect path can reject outside any
 * caller (an unhandled rejection is fatal in this backend) and its HTTP retries
 * outlive `disconnect()`. The listener reconnects through its jobRunner
 * reconciliation instead.
 */
export function createSlackSocket(
  appToken: string,
  handlers: SlackSocketHandlers,
  options: { fetch?: typeof fetch } = {}
): SlackSocket {
  const client = new SocketModeClient({
    appToken,
    logger: sdkLogger,
    autoReconnectEnabled: false,
    clientOptions: {
      retryConfig: { retries: 0 },
      timeout: 10_000,
      rejectRateLimitedCalls: true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
  let wanted = true;
  // The SDK consumes `hello` without exposing it; its raw frame carries `connection_info.app_id`.
  client.on('ws_message', (data: unknown) => {
    if (!wanted || typeof data !== 'string' || data.length > HELLO_MAX_LENGTH) {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (helloSchema.safeParse(frame).success) {
      handlers.onHello(frame);
    }
  });
  client.on(
    'slack_event',
    (event: {
      type?: unknown;
      envelope_id?: unknown;
      body?: unknown;
      ack: () => Promise<void>;
    }) => {
      if (!(wanted && envelopeSchema.safeParse(event).success) || typeof event.type !== 'string') {
        return;
      }
      void handlers.onEnvelope({ type: event.type, body: event.body, ack: () => event.ack() });
    }
  );
  client.on('disconnected', () => {
    if (wanted) {
      wanted = false;
      handlers.onDisconnected();
    }
  });
  // `disconnect()` cannot cancel an in-flight `apps.connections.open`; close what it opens late.
  client.on('connected', () => {
    if (!wanted) {
      void client.disconnect();
    }
  });
  return {
    start: () => client.start(),
    disconnect: () => {
      wanted = false;
      return client.disconnect();
    },
  };
}
