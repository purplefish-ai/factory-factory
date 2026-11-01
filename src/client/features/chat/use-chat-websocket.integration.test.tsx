// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LeftControls } from '@/client/features/chat/chat-input/components/input-controls';
import { loadSettings, persistSettings } from '@/client/features/chat/chat-persistence';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import {
  useChatWebSocket,
  type UseChatWebSocketReturn,
} from '@/client/features/chat/use-chat-websocket';
import { createTrpcClient, trpc } from '@/client/lib/trpc';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';

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

const capabilities: ChatBarCapabilities = {
  ...EMPTY_CHAT_BAR_CAPABILITIES,
  provider: 'CODEX',
  model: {
    enabled: true,
    selected: 'six-sol',
    options: [
      { value: 'six-sol', label: '6 Sol' },
      { value: 'six-luna', label: '6 Luna' },
    ],
  },
  reasoning: {
    enabled: true,
    selected: 'low',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
  planMode: { enabled: true },
};
const modelOption: AcpConfigOption = {
  id: 'runtime-model',
  category: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'six-sol',
  options: [
    { value: 'six-sol', name: '6 Sol' },
    { value: 'six-luna', name: '6 Luna' },
  ],
};
const reasoningOption: AcpConfigOption = {
  id: 'thought_level',
  name: 'Reasoning',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};
const outboundSchema = z.object({
  type: z.string(),
  requestId: z.string().optional(),
  loadRequestId: z.string().optional(),
  settings: z
    .object({ selectedModel: z.string(), reasoningEffort: z.string().nullable() })
    .optional(),
});
const cleanups: (() => void)[] = [];

function Harness({
  chatRef,
  sessionId,
}: {
  chatRef: { current: UseChatWebSocketReturn | undefined };
  sessionId: string;
}) {
  const fileInputRef = createRef<HTMLInputElement>();
  const chat = useChatWebSocket({ dbSessionId: sessionId });
  chatRef.current = chat;
  return (
    <LeftControls
      settings={chat.chatSettings}
      capabilities={chat.chatCapabilities}
      capabilitiesLoaded={chat.chatCapabilitiesLoaded}
      acpConfigOptions={chat.acpConfigOptions}
      onSetConfigOption={chat.setConfigOption}
      onModelChange={(selectedModel) => chat.updateSettings({ selectedModel })}
      onReasoningChange={() => undefined}
      onThinkingChange={() => undefined}
      onPlanModeChange={() => undefined}
      running={false}
      disabled={false}
      modLabel="⌘"
      modifierHeld={false}
      fileInputRef={fileInputRef}
      onFileSelect={() => undefined}
      supportedImageTypes={[]}
      onQuickAction={() => undefined}
      quickActionsOpen={false}
      onQuickActionsOpenChange={() => undefined}
    />
  );
}

async function mount(initialCapabilities = capabilities) {
  const chatRef: { current: UseChatWebSocketReturn | undefined } = { current: undefined };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const client = createTrpcClient();
  const render = (sessionId: string) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <trpc.Provider client={client} queryClient={queryClient}>
          <Harness chatRef={chatRef} sessionId={sessionId} />
        </trpc.Provider>
      </QueryClientProvider>
    );
  await act(() => render('websocket-config'));
  cleanups.push(() => {
    root.unmount();
    queryClient.clear();
    container.remove();
  });
  const socket = BrowserSocket.sockets.at(-1)!;
  await act(() => socket.open());
  await act(() => socket.receive({ type: 'chat_capabilities', capabilities: initialCapabilities }));
  return {
    container,
    socket,
    switchSession: async (sessionId: string) => {
      await act(() => render(sessionId));
    },
    get chat() {
      if (!chatRef.current) {
        throw new Error('Hook did not render');
      }
      return chatRef.current;
    },
    hydrate: async (socket: BrowserSocket, configOptions: AcpConfigOption[]) => {
      const loadRequestId = socket.sent
        .map((message) => outboundSchema.parse(JSON.parse(message)))
        .findLast((message) => message.type === 'load_session')?.loadRequestId;
      expect(loadRequestId).toBeDefined();
      await act(() =>
        socket.receive({
          type: 'session_replay_batch',
          loadRequestId,
          replayEvents: [
            { type: 'chat_capabilities', capabilities },
            { type: 'config_options_update', configOptions },
          ],
        })
      );
    },
    reconnect: async () => {
      await act(() => window.dispatchEvent(new Event('online')));
      const next = BrowserSocket.sockets.at(-1)!;
      expect(next).not.toBe(socket);
      await act(() => next.open());
      return next;
    },
  };
}

beforeEach(() => {
  sessionStorage.clear();
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
  sessionStorage.clear();
});

describe('real chat WebSocket configuration lifecycle', () => {
  it('keeps a model choice outbound when disconnecting before a model is confirmed', async () => {
    const harness = await mount({
      ...capabilities,
      model: { ...capabilities.model, selected: undefined },
    });
    await act(() => harness.chat.updateSettings({ selectedModel: 'six-luna' }));
    await act(() => harness.socket.close());
    expect(harness.chat.chatSettings.selectedModel).toBe('six-luna');
    const next = await harness.reconnect();
    await act(() => harness.chat.sendMessage('Use the visible model choice'));
    expect(outboundSchema.parse(JSON.parse(next.sent.at(-1)!)).settings?.selectedModel).toBe(
      'six-luna'
    );
  });

  it('does not persist a previous session rollback under the newly selected session', async () => {
    const saved = {
      selectedModel: 'six-luna',
      reasoningEffort: 'high',
      thinkingEnabled: true,
      planModeEnabled: true,
    };
    persistSettings('next-session', saved);
    const harness = await mount();
    await harness.hydrate(harness.socket, [modelOption, reasoningOption]);
    await act(() => harness.chat.setConfigOption(reasoningOption.id, 'high'));
    await harness.switchSession('next-session');
    expect(loadSettings('next-session')).toEqual(saved);
  });

  it('rolls back an unanswered native change on socket close and adopts reconnect settings', async () => {
    const harness = await mount();
    // Use an existing supported alias here; alias coverage is tested separately.
    const option = { ...reasoningOption, id: 'reasoning_effort' };
    await harness.hydrate(harness.socket, [modelOption, option]);
    await act(() => harness.chat.setConfigOption(option.id, 'high'));
    expect(harness.chat.acpConfigOptions?.find((item) => item.id === option.id)?.currentValue).toBe(
      'high'
    );
    await act(() => harness.socket.close());
    expect(harness.chat.connected).toBe(false);
    expect(harness.chat.acpConfigOptions?.find((item) => item.id === option.id)?.currentValue).toBe(
      'low'
    );
    expect(harness.chat.chatSettings.reasoningEffort).toBe('low');
    expect(loadSettings('websocket-config')?.reasoningEffort).toBe('low');
    const next = await harness.reconnect();
    await harness.hydrate(next, [modelOption, { ...option, currentValue: 'high' }]);
    await act(() => harness.chat.sendMessage('Use server-confirmed reconnect settings'));
    expect(outboundSchema.parse(JSON.parse(next.sent.at(-1)!)).settings?.reasoningEffort).toBe(
      'high'
    );
  });

  it.each(['rejected', 'lost'] as const)(
    'restores a capability model choice with a %s reply',
    async (reply) => {
      const harness = await mount();
      await act(() => harness.chat.updateSettings({ selectedModel: 'six-luna' }));
      expect(harness.chat.chatSettings.selectedModel).toBe('six-luna');
      if (reply === 'rejected') {
        const requestId = outboundSchema.parse(JSON.parse(harness.socket.sent.at(-1)!)).requestId;
        expect(requestId).toBeDefined();
        await act(() =>
          harness.socket.receive({ type: 'error', message: 'Model rejected', requestId })
        );
      }
      await act(() => harness.socket.close());
      expect(harness.chat.chatSettings.selectedModel).toBe('six-sol');
      expect(loadSettings('websocket-config')?.selectedModel).toBe('six-sol');
      const next = await harness.reconnect();
      await harness.hydrate(next, [modelOption]);
      await act(() => harness.chat.sendMessage('Use the old confirmed model'));
      expect(outboundSchema.parse(JSON.parse(next.sent.at(-1)!)).settings?.selectedModel).toBe(
        'six-sol'
      );
    }
  );

  it('adopts a capability-only reconnect model when the lost command actually succeeded', async () => {
    const harness = await mount();
    await act(() => harness.chat.updateSettings({ selectedModel: 'six-luna' }));
    await act(() => harness.socket.close());
    const next = await harness.reconnect();
    await act(() =>
      next.receive({
        type: 'chat_capabilities',
        capabilities: {
          ...capabilities,
          model: { ...capabilities.model, selected: 'six-luna' },
        },
      })
    );
    await act(() => harness.chat.sendMessage('Use the accepted server model'));
    expect(outboundSchema.parse(JSON.parse(next.sent.at(-1)!)).settings?.selectedModel).toBe(
      'six-luna'
    );
  });

  it('does not replay a model change that was rolled back as unsent while disconnected', async () => {
    const harness = await mount();
    await act(() => harness.socket.close());
    expect(harness.chat.connected).toBe(false);

    await act(() => harness.chat.updateSettings({ selectedModel: 'six-luna' }));
    expect(harness.chat.chatSettings.selectedModel).toBe('six-sol');
    expect(
      harness.chat.messages.some(
        (message) =>
          message.message?.type === 'error' && message.message.error?.includes('not sent')
      )
    ).toBe(true);

    const next = await harness.reconnect();
    const replayedTypes = next.sent.map((raw) => outboundSchema.parse(JSON.parse(raw)).type);
    expect(replayedTypes).not.toContain('set_model');
  });

  it('does not replay a config option change that was rolled back as unsent', async () => {
    const harness = await mount();
    await harness.hydrate(harness.socket, [modelOption, reasoningOption]);
    await act(() => harness.socket.close());

    await act(() => harness.chat.setConfigOption(reasoningOption.id, 'high'));
    expect(harness.chat.chatSettings.reasoningEffort).toBe('low');

    const next = await harness.reconnect();
    const replayedTypes = next.sent.map((raw) => outboundSchema.parse(JSON.parse(raw)).type);
    expect(replayedTypes).not.toContain('set_config_option');
  });

  it('shows the real native model control as busy until its correlated reply arrives', async () => {
    const harness = await mount();
    await harness.hydrate(harness.socket, [modelOption]);
    await act(() => harness.chat.setConfigOption(modelOption.id, 'six-luna'));
    const trigger = () =>
      harness.container.querySelector('[aria-label="Provider and model: Codex · 6 Luna"]');
    expect(trigger()).not.toBeNull();
    expect(trigger()?.getAttribute('aria-busy')).toBe('true');
    const requestId = outboundSchema.parse(JSON.parse(harness.socket.sent.at(-1)!)).requestId;
    await act(() => {
      harness.socket.receive({
        type: 'config_options_update',
        configOptions: [{ ...modelOption, currentValue: 'six-luna' }],
      });
      harness.socket.receive({ type: 'config_option_applied', requestId });
    });
    expect(trigger()?.getAttribute('aria-busy')).toBe('false');
  });
});

it('withholds targeted controls until accepted hydration on every connection', async () => {
  const harness = await mount();
  expect(harness.chat.controlsHydrated).toBe(false);
  await harness.hydrate(harness.socket, [modelOption, reasoningOption]);
  expect(harness.chat.controlsHydrated).toBe(true);
  await act(() => harness.socket.close());
  expect(harness.chat.controlsHydrated).toBe(false);
  const next = await harness.reconnect();
  expect(harness.chat.connected).toBe(true);
  expect(harness.chat.controlsHydrated).toBe(false);
  await harness.hydrate(next, [modelOption, reasoningOption]);
  expect(harness.chat.controlsHydrated).toBe(true);
});
