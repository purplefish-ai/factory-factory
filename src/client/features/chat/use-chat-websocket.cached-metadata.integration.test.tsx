// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  useChatWebSocket,
  type UseChatWebSocketReturn,
} from '@/client/features/chat/use-chat-websocket';
import { createTrpcClient, trpc } from '@/client/lib/trpc';
import type { ChatConfigOption, CommandInfo } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

class BrowserSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static sockets: BrowserSocket[] = [];
  readyState = BrowserSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    BrowserSocket.sockets.push(this);
  }

  open() {
    this.readyState = BrowserSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string) {
    if (this.readyState !== BrowserSocket.OPEN) {
      throw new Error('Socket is closed');
    }
    this.sent.push(data);
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const LoadSessionSchema = z.object({
  type: z.literal('load_session'),
  loadRequestId: z.string(),
  cachedMetadata: z.object({ digests: z.array(z.string()) }).optional(),
});

const capabilities = { ...EMPTY_CHAT_BAR_CAPABILITIES, slashCommands: { enabled: true } };
const claudeCommands: CommandInfo[] = [
  { name: 'review', description: 'Review the change', argumentHint: '[path]' },
];
const codexCommands: CommandInfo[] = [{ name: 'compact', description: 'Compact the context' }];
const claudeOptions: ChatConfigOption[] = [
  {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];

const cleanups: (() => void)[] = [];

beforeEach(() => {
  BrowserSocket.sockets = [];
  vi.stubGlobal('WebSocket', BrowserSocket);
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({
  chatRef,
  sessionId,
}: {
  chatRef: { current: UseChatWebSocketReturn | undefined };
  sessionId: string;
}) {
  chatRef.current = useChatWebSocket({ dbSessionId: sessionId });
  return null;
}

async function mount(sessionId: string) {
  const chatRef: { current: UseChatWebSocketReturn | undefined } = { current: undefined };
  const container = document.createElement('div');
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const client = createTrpcClient();
  const render = (id: string) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <trpc.Provider client={client} queryClient={queryClient}>
          <Harness chatRef={chatRef} sessionId={id} />
        </trpc.Provider>
      </QueryClientProvider>
    );
  await act(() => render(sessionId));
  cleanups.push(() => {
    root.unmount();
    queryClient.clear();
  });
  return {
    get chat() {
      if (!chatRef.current) {
        throw new Error('Hook did not render');
      }
      return chatRef.current;
    },
    /** Open the newest socket and return the load it sent. */
    open: async () => {
      const socket = BrowserSocket.sockets.at(-1)!;
      await act(() => socket.open());
      const load = socket.sent
        .map((raw) => LoadSessionSchema.safeParse(JSON.parse(raw)))
        .findLast((parsed) => parsed.success);
      if (!load?.success) {
        throw new Error('No load_session sent');
      }
      return { socket, load: load.data };
    },
    reconnect: async () => {
      BrowserSocket.sockets.at(-1)!.close();
      await act(() => window.dispatchEvent(new Event('online')));
    },
    switchSession: async (id: string) => {
      await act(() => render(id));
    },
  };
}

/** What the server sends for a load: the replay, then capabilities and metadata. */
async function answerLoad(socket: BrowserSocket, loadRequestId: string, metadata: object[]) {
  await act(() =>
    socket.receive({
      type: 'session_replay_batch',
      loadRequestId,
      replayEvents: [
        {
          type: 'session_runtime_snapshot',
          sessionRuntime: {
            phase: 'idle',
            processState: 'stopped',
            activity: 'IDLE',
            updatedAt: '2026-11-23T00:00:00.000Z',
          },
        },
      ],
    })
  );
  await act(() =>
    socket.receive({ type: 'session_delta', data: { type: 'chat_capabilities', capabilities } })
  );
  for (const data of metadata) {
    await act(() => socket.receive({ type: 'session_delta', data }));
  }
}

function full(data: object, digest: string) {
  return { ...data, digest };
}

function acknowledgement(deltaType: string, digest: string) {
  return { type: 'cached_metadata', deltaType, digest };
}

const claudeConfig = { type: 'config_options_update', configOptions: claudeOptions };
const claudeSlash = { type: 'slash_commands', slashCommands: claudeCommands };

it('offers held metadata on reconnect and session switch and applies acknowledgements in place of payloads', async () => {
  const test = await mount('claude-session');
  const first = await test.open();
  expect(first.load.cachedMetadata).toBeUndefined();
  await answerLoad(first.socket, first.load.loadRequestId, [
    full(claudeConfig, 'v1:claude-config'),
    full(claudeSlash, 'v1:claude-slash'),
  ]);
  expect(test.chat.slashCommands).toEqual(claudeCommands);
  expect(test.chat.acpConfigOptions).toEqual(claudeOptions);

  // Reconnect: the replay resets config options; the acknowledgements restore both.
  await test.reconnect();
  const resumed = await test.open();
  expect(resumed.load.cachedMetadata?.digests).toEqual(['v1:claude-config', 'v1:claude-slash']);
  await answerLoad(resumed.socket, resumed.load.loadRequestId, [
    acknowledgement('config_options_update', 'v1:claude-config'),
    acknowledgement('slash_commands', 'v1:claude-slash'),
  ]);
  expect(test.chat.acpConfigOptions).toEqual(claudeOptions);
  expect(test.chat.slashCommands).toEqual(claudeCommands);
  expect(test.chat.slashCommandsLoaded).toBe(true);

  // A session of another provider: the server sends its different content whole.
  await test.switchSession('codex-session');
  const codex = await test.open();
  await answerLoad(codex.socket, codex.load.loadRequestId, [
    full({ type: 'slash_commands', slashCommands: codexCommands }, 'v1:codex-slash'),
  ]);
  expect(test.chat.slashCommands).toEqual(codexCommands);
  expect(test.chat.acpConfigOptions).toBeNull();

  // Back again: the switch cleared the controls, and the cached copies refill them.
  await test.switchSession('claude-session');
  const back = await test.open();
  expect(back.load.cachedMetadata?.digests).toEqual([
    'v1:claude-config',
    'v1:claude-slash',
    'v1:codex-slash',
  ]);
  await answerLoad(back.socket, back.load.loadRequestId, [
    acknowledgement('config_options_update', 'v1:claude-config'),
    acknowledgement('slash_commands', 'v1:claude-slash'),
  ]);
  expect(test.chat.slashCommands).toEqual(claudeCommands);
  expect(test.chat.acpConfigOptions).toEqual(claudeOptions);

  // Commands changed on the server while disconnected: the new payload replaces them.
  const changed = [...claudeCommands, { name: 'deploy', description: 'Deploy' }];
  await test.reconnect();
  const afterChange = await test.open();
  await answerLoad(afterChange.socket, afterChange.load.loadRequestId, [
    acknowledgement('config_options_update', 'v1:claude-config'),
    full({ type: 'slash_commands', slashCommands: changed }, 'v1:claude-slash-2'),
  ]);
  expect(test.chat.slashCommands).toEqual(changed);
});

it('drops an acknowledgement for content it did not offer on this connection', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const test = await mount('unknown-ack-session');
  const { socket, load } = await test.open();
  await answerLoad(socket, load.loadRequestId, [
    acknowledgement('config_options_update', 'v1:never-sent'),
    acknowledgement('slash_commands', 'v1:never-sent-either'),
  ]);
  expect(test.chat.acpConfigOptions).toBeNull();
  expect(test.chat.slashCommands).toEqual([]);
  expect(test.chat.slashCommandsLoaded).toBe(false);
  expect(error).toHaveBeenCalledWith(
    '[chat] Dropped metadata acknowledgement that matches nothing offered',
    expect.objectContaining({ digest: 'v1:never-sent' })
  );
});
