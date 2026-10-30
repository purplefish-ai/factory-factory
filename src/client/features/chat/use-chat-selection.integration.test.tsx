// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { loadSettings, persistSettings } from './chat-persistence';
import { type UseChatStateReturn, useChatState } from './use-chat-state';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const capabilities: ChatBarCapabilities = {
  ...EMPTY_CHAT_BAR_CAPABILITIES,
  model: {
    enabled: true,
    selected: 'sonnet',
    options: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
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
  thinking: { enabled: true },
  planMode: { enabled: true },
};
const restoredSettings = {
  selectedModel: 'opus',
  reasoningEffort: 'high',
  thinkingEnabled: true,
  planModeEnabled: true,
};
const cleanups: (() => void)[] = [];

function SelectionHarness({
  sessionId,
  send,
  chatRef,
}: {
  sessionId: string | null;
  send: (message: unknown) => boolean;
  chatRef: { current: UseChatStateReturn | undefined };
}) {
  chatRef.current = useChatState({ dbSessionId: sessionId, send, connected: true });
  return null;
}

async function mount(initialSessionId: string | null = 'session-A') {
  const chatRef: { current: UseChatStateReturn | undefined } = { current: undefined };
  const send = vi.fn((_message: unknown) => true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (sessionId: string | null) => {
    await act(() => root.render(createElement(SelectionHarness, { sessionId, send, chatRef })));
  };
  await render(initialSessionId);
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
  return {
    get chat() {
      if (!chatRef.current) {
        throw new Error('Hook did not render');
      }
      return chatRef.current;
    },
    send,
    render,
    capabilities: async () => {
      await act(() => chatRef.current?.handleMessage({ type: 'chat_capabilities', capabilities }));
    },
  };
}

function lastModelRequestId(harness: Awaited<ReturnType<typeof mount>>): string {
  const request = harness.send.mock.calls.at(-1)?.[0];
  if (
    typeof request === 'object' &&
    request !== null &&
    'requestId' in request &&
    typeof request.requestId === 'string'
  ) {
    return request.requestId;
  }
  throw new Error('Expected a correlated model request');
}

beforeEach(() => sessionStorage.clear());
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });
  sessionStorage.clear();
});

describe('session selection hydration and outbound settings', () => {
  it('sends the confirmed server model with restored reasoning, thinking, and planning', async () => {
    persistSettings('session-A', restoredSettings);
    const harness = await mount();
    expect(harness.chat.chatSettings).toEqual(restoredSettings);
    await harness.capabilities();
    await act(() => harness.chat.sendMessage('Hello'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'queue_message',
        settings: { ...restoredSettings, selectedModel: 'sonnet' },
      })
    );
  });

  it('does not send a stale bootstrap or persisted model before configuration loads', async () => {
    persistSettings('session-A', restoredSettings);
    const harness = await mount();
    await act(() => harness.chat.sendMessage('Hello'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'queue_message', settings: undefined })
    );
  });

  it('uses an immediate explicit edit when sending in the same callback', async () => {
    const harness = await mount();
    await harness.capabilities();
    await act(() => {
      harness.chat.updateSettings({
        selectedModel: 'opus',
        reasoningEffort: 'high',
        planModeEnabled: true,
      });
      harness.chat.sendMessage('Hello');
    });
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'queue_message',
        settings: expect.objectContaining({
          selectedModel: 'opus',
          reasoningEffort: 'high',
          planModeEnabled: true,
        }),
      })
    );
    expect(loadSettings('session-A')).toEqual(harness.chat.chatSettings);
  });

  it('keeps a native model selection through unrelated edits and stale capabilities', async () => {
    const harness = await mount();
    await harness.capabilities();
    await act(() =>
      harness.chat.handleMessage({
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'new-model',
            options: [{ value: 'new-model', name: 'New model' }],
          },
        ],
      })
    );
    await act(() => harness.chat.updateSettings({ planModeEnabled: true }));
    await harness.capabilities();
    await act(() => harness.chat.sendMessage('Hello'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ selectedModel: 'new-model' }) })
    );
  });

  it.each(['native', 'capability'] as const)(
    'rolls back an unsent %s model choice and preserves the draft',
    async (control) => {
      const harness = await mount();
      await harness.capabilities();
      await act(() => harness.chat.setInputDraft('Keep this draft'));
      harness.send.mockReturnValue(false);
      await act(() => {
        if (control === 'native') {
          harness.chat.setConfigOption('model', 'opus');
        } else {
          harness.chat.updateSettings({ selectedModel: 'opus' });
        }
      });
      expect(harness.chat.pendingModelRequestId).toBeNull();
      expect(harness.chat.chatSettings.selectedModel).toBe('sonnet');
      expect(loadSettings('session-A')?.selectedModel).toBe('sonnet');
      expect(harness.chat.inputDraft).toBe('Keep this draft');
      expect(
        harness.chat.messages.some(
          (message) =>
            message.message?.type === 'error' && message.message.error?.includes('not sent')
        )
      ).toBe(true);
    }
  );

  it.each(['native', 'capability'] as const)(
    'rolls back a rejected latest %s model request before sending',
    async (control) => {
      const harness = await mount();
      await harness.capabilities();
      await act(() => {
        if (control === 'native') {
          harness.chat.setConfigOption('model', 'opus');
        } else {
          harness.chat.updateSettings({ selectedModel: 'opus' });
        }
      });
      const request = harness.send.mock.calls.at(-1)?.[0];
      expect(request).toEqual(expect.objectContaining({ requestId: expect.any(String) }));
      const requestId = lastModelRequestId(harness);
      await act(() => {
        harness.chat.handleMessage({ type: 'error', message: 'Model rejected', requestId });
        harness.chat.sendMessage('Use confirmed model immediately');
      });
      expect(harness.send).toHaveBeenLastCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ selectedModel: 'sonnet' }) })
      );
      expect(harness.chat.pendingModelRequestId).toBeNull();
      expect(loadSettings('session-A')?.selectedModel).toBe('sonnet');
      await act(() =>
        harness.chat.handleMessage({
          type: 'config_options_update',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'sonnet',
              options: [],
            },
          ],
        })
      );
      expect(harness.chat.chatSettings.selectedModel).toBe('sonnet');
      await act(() => harness.chat.sendMessage('Use confirmed model'));
      expect(harness.send).toHaveBeenLastCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ selectedModel: 'sonnet' }) })
      );
    }
  );

  it('keeps a newer edit when an older request fails, including a repeated model value', async () => {
    const harness = await mount();
    await harness.capabilities();
    await act(() => harness.chat.setConfigOption('model', 'opus'));
    const oldRequestId = lastModelRequestId(harness);
    await act(() => harness.chat.setConfigOption('model', 'sonnet'));
    await act(() => harness.chat.setConfigOption('model', 'opus'));
    expect(lastModelRequestId(harness)).not.toBe(oldRequestId);
    await act(() =>
      harness.chat.handleMessage({
        type: 'error',
        message: 'Old request rejected',
        requestId: oldRequestId,
      })
    );
    await act(() =>
      harness.chat.handleMessage({
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'sonnet',
            options: [],
          },
        ],
      })
    );
    await act(() => harness.chat.sendMessage('Keep latest choice'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ selectedModel: 'opus' }) })
    );
  });

  it('retains the latest fast model edit through an older config acknowledgement', async () => {
    const harness = await mount();
    await harness.capabilities();
    await act(() => harness.chat.updateSettings({ selectedModel: 'opus' }));
    await act(() => harness.chat.updateSettings({ selectedModel: 'sonnet' }));
    const acknowledge = (currentValue: string) =>
      harness.chat.handleMessage({
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue,
            options: [],
          },
        ],
      });
    await act(() => acknowledge('opus'));
    await act(() => harness.chat.sendMessage('Keep latest choice'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ selectedModel: 'sonnet' }),
      })
    );
    // Backend configuration transactions publish in request order. An earlier
    // command cannot publish a stale model after this matching acknowledgement.
    await act(() => acknowledge('sonnet'));
    expect(harness.chat.modelSelectionSource).toBe('server');
    expect(harness.chat.chatSettings.selectedModel).toBe('sonnet');
  });

  it('adopts a subsequent server model change when no local request is pending', async () => {
    const harness = await mount();
    await harness.capabilities();
    expect(harness.chat.pendingModelRequestId).toBeNull();
    // A later change from another viewer is authoritative after local work ends.
    await act(() =>
      harness.chat.handleMessage({
        type: 'config_options_update',
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: 'opus', options: [] },
        ],
      })
    );
    expect(harness.chat.chatSettings.selectedModel).toBe('opus');
  });

  it('preserves reasoning when changing only the model', async () => {
    persistSettings('session-A', restoredSettings);
    const harness = await mount();
    await harness.capabilities();
    await act(() => harness.chat.updateSettings({ selectedModel: 'opus' }));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'set_model',
        model: 'opus',
        reasoningEffort: 'high',
      }),
      { queuePolicy: 'drop' }
    );
  });

  it('uses the new model default when the previous reasoning choice is unsupported', async () => {
    persistSettings('session-A', restoredSettings);
    const harness = await mount();
    await harness.capabilities();
    await act(() => harness.chat.updateSettings({ selectedModel: 'opus' }));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'opus', reasoningEffort: 'high' }),
      { queuePolicy: 'drop' }
    );
    await act(() => {
      harness.chat.handleMessage({
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'opus',
            options: [],
          },
        ],
      });
      // The backend validates the carried effort against the newly selected
      // model. Unsupported high leaves its provider-selected medium in place.
      harness.chat.handleMessage({
        type: 'chat_capabilities',
        capabilities: {
          ...capabilities,
          model: { ...capabilities.model, selected: 'opus' },
          reasoning: {
            enabled: true,
            selected: 'medium',
            options: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
            ],
          },
        },
      });
      harness.chat.sendMessage('Use the supported effort');
    });
    expect(harness.chat.chatSettings.reasoningEffort).toBe('medium');
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'queue_message',
        settings: expect.objectContaining({ selectedModel: 'opus', reasoningEffort: 'medium' }),
      })
    );
  });

  it('retains an unsaved draft when switching away and back before the debounce', async () => {
    const harness = await mount();
    await act(() => harness.chat.setInputDraft('Still typing'));
    await harness.render('session-B');
    await harness.render('session-A');
    expect(harness.chat.inputDraft).toBe('Still typing');
  });

  it('starts an empty sibling draft and restores the original draft and attachments on return', async () => {
    const harness = await mount();
    const attachment = {
      id: 'draft-attachment',
      name: 'notes.txt',
      type: 'text/plain',
      size: 4,
      data: 'text',
      contentType: 'text' as const,
    };
    await act(() => {
      harness.chat.setInputDraft('Original conversation draft');
      harness.chat.setInputAttachments([attachment]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await harness.render('session-B');
    expect(harness.chat.inputDraft).toBe('');
    expect(harness.chat.inputAttachments).toEqual([]);
    await harness.render('session-A');
    expect(harness.chat.inputDraft).toBe('Original conversation draft');
    expect(harness.chat.inputAttachments).toEqual([attachment]);
  });

  it('ignores old callbacks after returning to the same session', async () => {
    const harness = await mount();
    const oldHandleMessage = harness.chat.handleMessage;
    await harness.render('session-B');
    await harness.render('session-A');
    await act(() => oldHandleMessage({ type: 'chat_capabilities', capabilities }));
    expect(harness.chat.chatCapabilitiesLoaded).toBe(false);
  });

  it('resets selection authority when a session is selected from an empty chat', async () => {
    const harness = await mount(null);
    await act(() => harness.chat.updateSettings({ selectedModel: 'opus' }));
    await harness.render('session-B');
    await harness.capabilities();
    expect(harness.chat.chatSettings.selectedModel).toBe('sonnet');
  });

  it('ignores obsolete session callbacks and hydrates the next session independently', async () => {
    const harness = await mount();
    await harness.capabilities();
    const oldHandleMessage = harness.chat.handleMessage;
    await act(() => harness.chat.updateSettings({ selectedModel: 'opus' }));
    persistSettings('session-B', restoredSettings);
    await harness.render('session-B');
    await act(() =>
      oldHandleMessage({
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'old-model',
            options: [],
          },
        ],
      })
    );
    expect(harness.chat.chatSettings).toEqual(restoredSettings);
    await harness.capabilities();
    expect(harness.chat.chatSettings).toEqual({ ...restoredSettings, selectedModel: 'sonnet' });
  });
});
