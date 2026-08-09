// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { SubagentTranscriptContent } from './subagent-transcript-content';
import type { SubagentSelection } from './types';

const chatMocks = vi.hoisted(() => ({
  virtualizedMessageList: vi.fn(),
}));

vi.mock('@/client/features/chat', async () => {
  const { createElement: createMockElement } =
    await vi.importActual<typeof import('react')>('react');
  const renderItem = (item: { id: string }) =>
    createMockElement(
      'details',
      { key: item.id, 'data-message-id': item.id },
      createMockElement('summary', null, item.id)
    );
  return {
    GroupedMessageItemRenderer: ({ item }: { item: { id: string } }) => renderItem(item),
    VirtualizedMessageList: (props: { messages: Array<{ id: string }> }) => {
      chatMocks.virtualizedMessageList(props);
      return createMockElement('div', null, props.messages.map(renderItem));
    },
  };
});

const selection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Session 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'completed',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    latestActivity: null,
    resultPreview: null,
  },
};

function message(id: string, order: number): ChatMessage {
  return {
    id,
    source: 'user',
    text: id,
    timestamp: '1970-01-01T00:00:00.000Z',
    order,
  };
}

describe('SubagentTranscriptContent row identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    chatMocks.virtualizedMessageList.mockClear();
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(messages: ChatMessage[]): void {
    void act(() =>
      root.render(
        createElement(SubagentTranscriptContent, {
          workspaceId: 'workspace-1',
          selection,
          onBack: vi.fn(),
          state: {
            kind: 'ready',
            messages,
            hasOlder: false,
            loadingOlder: false,
            onLoadOlder: vi.fn(),
          },
        })
      )
    );
  }

  it('retains an existing row DOM node when older messages are prepended', () => {
    render([message('newest', 1)]);
    const existing = container.querySelector<HTMLDetailsElement>('[data-message-id="newest"]');
    if (!existing) {
      throw new Error('Expected newest transcript row');
    }
    existing.open = true;

    render([message('older', 0), message('newest', 1)]);

    const retained = container.querySelector<HTMLDetailsElement>('[data-message-id="newest"]');
    expect(retained).toBe(existing);
    expect(retained?.open).toBe(true);
  });

  it('routes the complete transcript through the virtualized renderer', () => {
    render([message('older', 0), message('newest', 1)]);

    expect(chatMocks.virtualizedMessageList).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ id: 'older' }),
          expect.objectContaining({ id: 'newest' }),
        ],
        running: false,
        startingSession: false,
        loadingSession: false,
      })
    );
  });
});
