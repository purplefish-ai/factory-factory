// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, persistSettings } from '@/client/features/chat/chat-persistence';
import { type UseChatStateReturn, useChatState } from '@/client/features/chat/use-chat-state';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { MessageState } from '@/lib/chat-protocol';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { actFlushSync } from '@/test-utils/react-act';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

interface ChatStateHarnessProps {
  dbSessionId: string | null;
  send: (message: unknown) => boolean;
  connected?: boolean;
  chatRef: { current: UseChatStateReturn | null };
}

function ChatStateHarness({ dbSessionId, send, chatRef, connected = true }: ChatStateHarnessProps) {
  chatRef.current = useChatState({ dbSessionId, send, connected });
  return null;
}

function renderChatState(
  initialSessionId: string | null,
  send = vi.fn((_message: unknown) => true),
  initialConnected = true
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const chatRef = { current: null as UseChatStateReturn | null };

  let connected = initialConnected;
  const render = (dbSessionId: string | null) => {
    root.render(createElement(ChatStateHarness, { dbSessionId, send, chatRef, connected }));
  };

  actFlushSync(() => {
    render(initialSessionId);
  });

  return {
    chatRef,
    send,
    setConnected: (value: boolean) => {
      connected = value;
      actFlushSync(() => render(initialSessionId));
    },
    rerenderSession: (dbSessionId: string | null) => {
      render(dbSessionId);
    },
    cleanup: () => {
      actFlushSync(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushDraftDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function createAttachment(): MessageAttachment {
  return {
    id: 'att-1',
    name: 'secret.txt',
    type: 'text/plain',
    size: 11,
    data: 'secret data',
    contentType: 'text',
  };
}

function getSentMessageId(send: ReturnType<typeof vi.fn>): string {
  const lastCall = send.mock.calls.at(-1);
  const message = lastCall?.[0];
  if (typeof message !== 'object' || message === null || !('id' in message)) {
    throw new Error('Expected queued message with an id');
  }
  const id = message.id;
  if (typeof id !== 'string') {
    throw new Error('Expected string message id');
  }
  return id;
}

describe('useChatState rejected message recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('compacts without attaching or clearing the next message draft', async () => {
    let harness: ReturnType<typeof renderChatState>;
    await act(async () => {
      harness = renderChatState('session-A');
      await flushEffects();
    });
    try {
      await act(async () => {
        harness.chatRef.current?.setInputDraft('Keep this next message');
        harness.chatRef.current?.setInputAttachments([createAttachment()]);
        await flushEffects();
      });
      await act(() => {
        harness.chatRef.current?.sendMessage('/compact', { preserveInput: true });
      });
      expect(harness!.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'queue_message',
          text: '/compact',
          attachments: undefined,
        })
      );
      expect(harness!.chatRef.current?.inputDraft).toBe('Keep this next message');
      expect(harness!.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
      await act(flushDraftDebounce);
      expect(sessionStorage.getItem('chat-draft-session-A')).toBe('Keep this next message');
      expect(sessionStorage.getItem('chat-attachments-session-A')).toContain('secret.txt');
    } finally {
      await act(() => {
        harness!.cleanup();
      });
    }
  });

  it('restores rejected message content for the same session', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.sendMessage('sensitive data');
    });

    const messageId = getSentMessageId(harness.send);
    actFlushSync(() => {
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: messageId,
          newState: MessageState.REJECTED,
          errorMessage: 'Rejected',
        },
      });
    });

    await flushEffects();
    await flushDraftDebounce();

    expect(harness.chatRef.current?.inputDraft).toBe('sensitive data');
    expect(harness.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
    expect(sessionStorage.getItem('chat-draft-session-A')).toBe('sensitive data');
    expect(sessionStorage.getItem('chat-attachments-session-A')).toContain('secret.txt');

    harness.cleanup();
  });

  it.each([MessageState.REJECTED, MessageState.FAILED])(
    'preserves a new draft when an earlier message becomes %s',
    async (newState) => {
      const harness = renderChatState('session-A');
      await flushEffects();
      try {
        actFlushSync(() => harness.chatRef.current?.sendMessage('earlier message'));
        const messageId = getSentMessageId(harness.send);
        actFlushSync(() => harness.chatRef.current?.setInputDraft('new draft'));
        actFlushSync(() =>
          harness.chatRef.current?.dispatch({
            type: 'MESSAGE_STATE_CHANGED',
            payload: { id: messageId, newState, errorMessage: 'Failed' },
          })
        );
        await flushEffects();
        expect(harness.chatRef.current?.inputDraft).toBe('new draft');
        expect(harness.chatRef.current?.lastRejectedMessage).toBeNull();
        actFlushSync(() => harness.chatRef.current?.setInputDraft(''));
        await flushEffects();
        expect(harness.chatRef.current?.inputDraft).toBe('');
      } finally {
        harness.cleanup();
      }
    }
  );

  it('preserves an attachment-only draft when an earlier message is rejected', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();
    try {
      actFlushSync(() => harness.chatRef.current?.sendMessage('earlier message'));
      const messageId = getSentMessageId(harness.send);
      actFlushSync(() => harness.chatRef.current?.setInputAttachments([createAttachment()]));
      actFlushSync(() =>
        harness.chatRef.current?.dispatch({
          type: 'MESSAGE_STATE_CHANGED',
          payload: { id: messageId, newState: MessageState.REJECTED, errorMessage: 'Rejected' },
        })
      );
      await flushEffects();
      expect(harness.chatRef.current?.inputDraft).toBe('');
      expect(harness.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
      expect(harness.chatRef.current?.lastRejectedMessage).toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  it('warns when input attachments cannot be autosaved', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    actFlushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    expect(harness.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
    expect(sessionStorage.getItem('chat-attachments-session-A')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      'Attachments were not autosaved',
      expect.objectContaining({
        description:
          'They are still in this composer, but may be lost if you reload or switch sessions.',
      })
    );

    harness.cleanup();
  });

  it('warns when sent input attachments cannot be cleared from storage', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();
    const removeItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      if (key === 'chat-attachments-session-A') {
        throw new DOMException('Storage unavailable', 'InvalidStateError');
      }
      return removeItem.call(this, key);
    });

    actFlushSync(() => {
      harness.chatRef.current?.sendMessage('send with attachment');
    });

    await flushEffects();

    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-attachments-session-A')).toContain('secret.txt');
    expect(toast.error).toHaveBeenCalledWith(
      'Saved attachments could not be cleared',
      expect.objectContaining({
        description: 'Previously saved attachments may reappear after a reload or session switch.',
      })
    );

    harness.cleanup();
  });

  it('does not persist rejected message content into a newly selected session', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.sendMessage('sensitive data');
    });

    const messageId = getSentMessageId(harness.send);
    actFlushSync(() => {
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: messageId,
          newState: MessageState.REJECTED,
          errorMessage: 'Rejected',
        },
      });
      harness.rerenderSession('session-B');
    });

    await flushEffects();
    await flushDraftDebounce();

    expect(harness.chatRef.current?.inputDraft).not.toBe('sensitive data');
    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-draft-session-B') ?? '').not.toContain('sensitive data');
    expect(sessionStorage.getItem('chat-attachments-session-B') ?? '').not.toContain('secret.txt');

    harness.cleanup();
  });

  it('does not recover rejected message content without a captured source session', async () => {
    const harness = renderChatState(null);
    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    actFlushSync(() => {
      harness.chatRef.current?.sendMessage('sensitive data');
    });

    const messageId = getSentMessageId(harness.send);
    actFlushSync(() => {
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: messageId,
          newState: MessageState.REJECTED,
          errorMessage: 'Rejected',
        },
      });
    });

    await flushEffects();
    await flushDraftDebounce();

    expect(harness.chatRef.current?.inputDraft).toBe('');
    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-draft-null')).toBeNull();
    expect(sessionStorage.getItem('chat-attachments-null')).toBeNull();

    harness.cleanup();
  });
});

describe('useChatState plan mode persistence', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'keeps %s planning settings in sync with its native control',
    async (provider) => {
      const harness = renderChatState('session-A');
      await flushEffects();
      actFlushSync(() =>
        harness.chatRef.current?.dispatch({
          type: 'WS_CHAT_CAPABILITIES',
          payload: {
            capabilities: { ...EMPTY_CHAT_BAR_CAPABILITIES, provider, planMode: { enabled: true } },
          },
        })
      );
      const configId = provider === 'CODEX' ? 'collaboration_mode' : 'mode';
      actFlushSync(() => harness.chatRef.current?.setConfigOption(configId, 'plan'));
      expect(loadSettings('session-A')?.planModeEnabled).toBe(true);
      actFlushSync(() => harness.chatRef.current?.setConfigOption(configId, 'default'));
      expect(loadSettings('session-A')?.planModeEnabled).toBe(false);
      if (provider === 'CODEX') {
        actFlushSync(() => harness.chatRef.current?.setConfigOption('mode', 'workspace-write'));
        expect(loadSettings('session-A')?.planModeEnabled).toBe(false);
      }
      harness.cleanup();
    }
  );

  it.each(['CLAUDE', 'CODEX'] as const)(
    'preserves %s native plan approval without an extra turn or mode override',
    async (provider) => {
      const capabilities: ChatBarCapabilities = {
        provider,
        model: { enabled: false, options: [] },
        reasoning: { enabled: false, options: [] },
        thinking: { enabled: false },
        planMode: { enabled: true },
        attachments: { enabled: false, kinds: [] },
        slashCommands: { enabled: false },
        usageStats: { enabled: false, contextWindow: false },
        rewind: { enabled: false },
      };
      const harness = renderChatState('session-A');
      await flushEffects();

      actFlushSync(() => {
        harness.chatRef.current?.dispatch({
          type: 'WS_CHAT_CAPABILITIES',
          payload: { capabilities },
        });
      });
      actFlushSync(() => {
        harness.chatRef.current?.updateSettings({ planModeEnabled: true });
      });

      expect(loadSettings('session-A')?.planModeEnabled).toBe(true);
      actFlushSync(() =>
        harness.chatRef.current?.dispatch({
          type: 'CONFIG_OPTIONS_UPDATE',
          payload: {
            configOptions: [
              {
                id: provider === 'CODEX' ? 'collaboration_mode' : 'mode',
                name: 'Mode',
                type: 'select',
                category: provider === 'CODEX' ? 'collaboration_mode' : 'mode',
                currentValue: 'plan',
                options: ['plan', 'default'].map((value) => ({ value, name: value })),
              },
            ],
          },
        })
      );

      actFlushSync(() => {
        harness.chatRef.current?.dispatch({
          type: 'WS_PERMISSION_REQUEST',
          payload: {
            requestId: 'exit-plan',
            toolName: 'ExitPlanMode',
            toolInput: {},
            acpOptions: [
              { optionId: 'native-accept-edits', name: 'Accept edits', kind: 'allow_once' },
            ],
            timestamp: '2026-07-30T00:00:00.000Z',
          },
        });
      });
      actFlushSync(() => {
        harness.chatRef.current?.approvePermission('exit-plan', true, 'native-accept-edits');
      });

      expect(harness.chatRef.current?.chatSettings.planModeEnabled).toBe(false);
      expect(loadSettings('session-A')?.planModeEnabled).toBe(false);
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue_message' })
      );
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'set_config_option' })
      );
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission_response',
          requestId: 'exit-plan',
          optionId: 'native-accept-edits',
        })
      );

      harness.cleanup();
    }
  );
});

describe('form elicitation answer submission', () => {
  it.each(['Decline', ' decline ', ['Decline', 'Submit']])(
    'accepts the form when an answer contains %j',
    async (answer) => {
      const harness = renderChatState('session-A');
      await flushEffects();
      try {
        actFlushSync(() => {
          harness.chatRef.current?.dispatch({
            type: 'WS_USER_QUESTION',
            payload: {
              requestId: 'elicitation-question',
              timestamp: '2026-10-27T00:00:00Z',
              questions: [{ id: 'decision', question: 'Proceed?', options: [] }],
              acpOptions: [
                { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
                { optionId: 'accept', name: 'Submit', kind: 'allow_once' },
              ],
            },
          });
        });
        actFlushSync(() => {
          harness.chatRef.current?.answerQuestion('elicitation-question', { decision: answer });
        });
        expect(harness.send).toHaveBeenCalledWith({
          type: 'permission_response',
          requestId: 'elicitation-question',
          optionId: 'accept',
          answers: { decision: Array.isArray(answer) ? answer : [answer.trim()] },
        });
        expect(harness.chatRef.current?.pendingRequest).toEqual({ type: 'none' });
      } finally {
        harness.cleanup();
      }
    }
  );
});

it('keeps a failed PR update out of an empty composer', async () => {
  let harness!: ReturnType<typeof renderChatState>;
  await act(() => {
    harness = renderChatState('session-A');
  });
  try {
    await act(() =>
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_SENDING',
        payload: {
          id: 'pr-event-failed-composer',
          text: '<!-- factory-factory-pr-event:test -->\nReview feedback',
          sessionId: 'session-A',
        },
      })
    );
    await act(() =>
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'pr-event-failed-composer',
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: '<!-- factory-factory-pr-event:test -->\nReview feedback',
            timestamp: '2026-10-27T00:00:00Z',
          },
        },
      })
    );
    expect(harness.chatRef.current?.queuedMessages).toEqual([
      expect.objectContaining({ id: 'pr-event-failed-composer', sessionId: 'session-A' }),
    ]);
    await act(() =>
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: 'pr-event-failed-composer',
          newState: MessageState.FAILED,
          errorMessage: 'Provider unavailable',
        },
      })
    );
    expect(harness.chatRef.current?.inputDraft).toBe('');
    expect(harness.chatRef.current?.messages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ type: 'pr_update', prDeliveryState: 'failed' }),
      }),
    ]);
  } finally {
    await act(() => harness.cleanup());
  }
});

describe('pending native settings', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('preserves saved settings during the initial disconnected render', async () => {
    const savedSettings = {
      selectedModel: 'saved-model',
      reasoningEffort: 'high',
      thinkingEnabled: true,
      planModeEnabled: true,
    };
    persistSettings('initial-disconnect', savedSettings);
    let harness!: ReturnType<typeof renderChatState>;
    await act(() => {
      harness = renderChatState(
        'initial-disconnect',
        vi.fn((_message: unknown) => true),
        false
      );
    });
    try {
      await act(flushEffects);
      expect(harness.chatRef.current?.chatSettings).toEqual(savedSettings);
      expect(loadSettings('initial-disconnect')).toEqual(savedSettings);
    } finally {
      await act(() => harness.cleanup());
    }
  });

  it('keeps the latest native choice visible through current-turn updates and older rejections', async () => {
    const send = vi.fn((_message: unknown) => true);
    const harness = renderChatState('pending-settings', send);
    await flushEffects();
    const option = {
      id: 'mode',
      name: 'Access',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'review', name: 'Review' },
      ],
    };
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: { configOptions: [option] },
      })
    );
    actFlushSync(() => harness.chatRef.current?.setConfigOption('mode', 'review'));
    const older = harness.send.mock.calls.at(-1)?.[0];
    if (
      !older ||
      typeof older !== 'object' ||
      !('requestId' in older) ||
      typeof older.requestId !== 'string'
    ) {
      throw new Error('Expected request correlation');
    }
    expect(harness.chatRef.current?.acpConfigOptions?.[0]?.currentValue).toBe('review');
    actFlushSync(() => harness.chatRef.current?.setConfigOption('mode', 'default'));
    const latest = harness.send.mock.calls.at(-1)?.[0];
    if (
      !latest ||
      typeof latest !== 'object' ||
      !('requestId' in latest) ||
      typeof latest.requestId !== 'string'
    ) {
      throw new Error('Expected request correlation');
    }
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: { configOptions: [{ ...option, currentValue: 'review' }] },
      })
    );
    actFlushSync(() =>
      harness.chatRef.current?.handleMessage({
        type: 'error',
        requestId: older.requestId,
        message: 'rejected',
      })
    );
    expect(harness.chatRef.current?.acpConfigOptions?.[0]?.currentValue).toBe('default');
    actFlushSync(() =>
      harness.chatRef.current?.handleMessage({
        type: 'error',
        requestId: latest.requestId,
        message: 'rejected',
      })
    );
    expect(harness.chatRef.current?.acpConfigOptions?.[0]?.currentValue).toBe('review');
    actFlushSync(() => harness.chatRef.current?.setConfigOption('mode', 'default'));
    const applied = harness.send.mock.calls.at(-1)?.[0];
    if (
      !applied ||
      typeof applied !== 'object' ||
      !('requestId' in applied) ||
      typeof applied.requestId !== 'string'
    ) {
      throw new Error('Expected request correlation');
    }
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: { configOptions: [option] },
      })
    );
    actFlushSync(() =>
      harness.chatRef.current?.handleMessage({
        type: 'config_option_applied',
        requestId: applied.requestId,
      })
    );
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: { configOptions: [{ ...option, currentValue: 'review' }] },
      })
    );
    expect(harness.chatRef.current?.acpConfigOptions?.[0]?.currentValue).toBe('review');
    actFlushSync(() => harness.chatRef.current?.setConfigOption('mode', 'default'));
    harness.setConnected(false);
    await flushEffects();
    harness.setConnected(true);
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: { configOptions: [{ ...option, currentValue: 'review' }] },
      })
    );
    expect(harness.chatRef.current?.acpConfigOptions?.[0]?.currentValue).toBe('review');
    harness.cleanup();
  });

  it('uses a selected native reasoning level when queuing the next message', async () => {
    const harness = renderChatState('pending-reasoning');
    await flushEffects();
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'WS_CHAT_CAPABILITIES',
        payload: {
          capabilities: {
            ...EMPTY_CHAT_BAR_CAPABILITIES,
            provider: 'CODEX',
            reasoning: {
              enabled: true,
              selected: 'low',
              options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
              ],
            },
          },
        },
      })
    );
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: {
          configOptions: [
            {
              id: 'reasoning_effort',
              category: 'thought_level',
              name: 'Thinking',
              type: 'select',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      })
    );
    actFlushSync(() => harness.chatRef.current?.setConfigOption('reasoning_effort', 'high'));
    actFlushSync(() => harness.chatRef.current?.sendMessage('next turn'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'queue_message',
        settings: expect.objectContaining({ reasoningEffort: 'high' }),
      })
    );
    harness.setConnected(false);
    await flushEffects();
    harness.setConnected(true);
    actFlushSync(() =>
      harness.chatRef.current?.dispatch({
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: {
          configOptions: [
            {
              id: 'reasoning_effort',
              category: 'thought_level',
              name: 'Thinking',
              type: 'select',
              currentValue: 'high',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      })
    );
    actFlushSync(() => harness.chatRef.current?.sendMessage('after reconnect'));
    expect(harness.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'queue_message',
        settings: expect.objectContaining({ reasoningEffort: 'high' }),
      })
    );
    harness.cleanup();
  });
});
