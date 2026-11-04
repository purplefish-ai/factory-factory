import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { SessionEventBus, sessionCommandFactories } from '@/backend/services/session';
import { MessageState } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { disposeChatTransportForApplication } from './chat-connection-registry';
import { createChatRouterServices } from './chat-message-router.test-helpers';
import { createChatUpgradeHandler } from './chat.handler';

class Viewer extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  bufferedAmount = 0;
  terminate = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

const applications: AppContext[] = [];
afterEach(() => {
  for (const app of applications.splice(0)) {
    disposeChatTransportForApplication(app);
  }
});

function setup(sendSessionMessage: (sessionId: string, content: unknown) => Promise<void>) {
  const ports = createChatRouterServices(sessionCommandFactories);
  const bus = new SessionEventBus();
  const publish = vi.spyOn(bus, 'publishToSession');
  const app = unsafeCoerce<AppContext>({
    services: {
      sessionCommandFactories,
      acpRuntimeManager: { isSessionRunning: () => true },
      sessionDomainService: ports.execution.domain,
      sessionLoadService: ports.load,
      sessionLifecycleService: ports.execution.lifecycle,
      sessionBackgroundDeliveryService: ports.execution.backgroundDelivery,
      sessionDispatchService: ports.dispatch,
      sessionService: { sendSessionMessage },
      sessionPermissionService: ports.permission,
      sessionConfigService: ports.config,
      sessionEventBus: bus,
      chatEventForwarderService: { setupWorkspaceNotifications: vi.fn() },
      sessionFileLogger: { initSession: vi.fn(), log: vi.fn(), closeSession: vi.fn() },
      createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      configService: {
        getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
        getDebugConfig: () => ({ chatWebSocket: false }),
        getWebSocketConfig: () => ({ maxFrameBytes: 33_554_432 }),
      },
    },
  });
  applications.push(app);
  const handler = createChatUpgradeHandler(app);
  const connect = (connectionId: string) => {
    const viewer = new Viewer();
    const wss = unsafeCoerce<WebSocketServer>({
      handleUpgrade: (
        _request: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        callback: (socket: WebSocket) => void
      ) => callback(unsafeCoerce(viewer)),
    });
    handler(
      unsafeCoerce({
        headers: { origin: 'http://localhost:3000' },
        socket: { remoteAddress: '127.0.0.1' },
      }),
      unsafeCoerce({ write: vi.fn(), destroy: vi.fn() }),
      Buffer.alloc(0),
      new URL(`http://localhost/chat?connectionId=${connectionId}&sessionId=shared-session`),
      wss,
      new WeakMap()
    );
    return viewer;
  };
  return { connect, publish };
}

it('returns a failed private draft only to its original sender among two active viewers', async () => {
  let fail!: (error: Error) => void;
  const turn = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const sendSessionMessage = vi.fn().mockReturnValueOnce(turn).mockResolvedValue(undefined);
  const { connect, publish } = setup(sendSessionMessage);
  const sender = connect('sender');
  const other = connect('other');
  const content = [
    { type: 'text', text: 'private failed draft' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ];
  sender.emit('message', JSON.stringify({ type: 'user_input', content }));
  await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledTimes(1));
  // A later request from the other viewer must not replace the first request's reply target.
  other.emit('message', JSON.stringify({ type: 'user_input', text: 'other viewer input' }));
  await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledTimes(2));
  expect(sender.send).not.toHaveBeenCalled();
  expect(other.send).not.toHaveBeenCalled();
  fail(new Error('provider disconnected'));
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledTimes(1));
  expect(JSON.parse(sender.send.mock.calls[0]![0])).toMatchObject({
    type: 'message_state_changed',
    newState: MessageState.REJECTED,
    userMessage: {
      sessionId: 'shared-session',
      text: 'private failed draft',
      attachments: [{ data: 'aGVsbG8=', type: 'image/png', contentType: 'image' }],
    },
  });
  expect(other.send).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(sendSessionMessage).toHaveBeenCalledTimes(2);
});
