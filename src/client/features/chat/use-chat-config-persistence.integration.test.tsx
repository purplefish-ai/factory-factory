// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { loadSettings, persistSettings } from '@/client/features/chat/chat-persistence';
import { useChatState, type UseChatStateReturn } from '@/client/features/chat/use-chat-state';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

function Harness({
  sessionId,
  chatRef,
  send,
}: {
  sessionId: string;
  chatRef: { current: UseChatStateReturn | undefined };
  send: (message: unknown) => boolean;
}) {
  chatRef.current = useChatState({ dbSessionId: sessionId, connected: true, send });
  return null;
}

it.each(['bootstrap', 'local'] as const)(
  'persists a rejected native reasoning rollback with %s model authority',
  async (modelAuthority) => {
    const sessionId = `effort-rollback-${modelAuthority}`;
    const savedSettings = {
      selectedModel: 'saved-model',
      reasoningEffort: 'low',
      thinkingEnabled: false,
      planModeEnabled: false,
    };
    persistSettings(sessionId, savedSettings);
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    let request: unknown;
    const chatRef: { current: UseChatStateReturn | undefined } = { current: undefined };
    const send = (message: unknown) => {
      request = message;
      return true;
    };
    try {
      await act(() => root.render(<Harness sessionId={sessionId} chatRef={chatRef} send={send} />));
      await act(() => {
        chatRef.current?.handleMessage({
          type: 'chat_capabilities',
          capabilities: {
            ...EMPTY_CHAT_BAR_CAPABILITIES,
            reasoning: {
              enabled: true,
              selected: 'low',
              options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
              ],
            },
          },
        });
        chatRef.current?.handleMessage({
          type: 'config_options_update',
          configOptions: [
            {
              id: 'reasoning_effort',
              name: 'Reasoning',
              type: 'select',
              currentValue: 'low',
              options: [],
            },
          ],
        });
      });
      if (modelAuthority === 'local') {
        await act(() => chatRef.current?.updateSettings({ selectedModel: 'explicit-model' }));
      }
      await act(() => chatRef.current?.setConfigOption('reasoning_effort', 'high'));
      expect(loadSettings(sessionId)?.reasoningEffort).toBe('high');
      const requestId = z.object({ requestId: z.string() }).parse(request).requestId;
      await act(() =>
        chatRef.current?.handleMessage({ type: 'error', message: 'Effort rejected', requestId })
      );
      expect(chatRef.current?.chatSettings.reasoningEffort).toBe('low');
      expect(chatRef.current?.modelSelectionSource).toBe(modelAuthority);
      expect(loadSettings(sessionId)?.reasoningEffort).toBe('low');
      await act(() => root.unmount());
      root = createRoot(container);
      await act(() => root.render(<Harness sessionId={sessionId} chatRef={chatRef} send={send} />));
      expect(chatRef.current?.chatSettings).toEqual({
        ...savedSettings,
        selectedModel: modelAuthority === 'local' ? 'explicit-model' : 'saved-model',
      });
    } finally {
      await act(() => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  }
);
