// @vitest-environment jsdom

import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { persistDraft, persistInputAttachments } from './chat-persistence';
import { type UseChatStateReturn, useChatState } from './use-chat-state';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

interface Commit {
  sessionId: string | null;
  draft: string;
  attachmentIds: string[];
}

const commits: Commit[] = [];
const cleanups: (() => void)[] = [];

function attachment(id: string): MessageAttachment {
  return { id, name: `${id}.txt`, type: 'text/plain', size: 1, data: 'x', contentType: 'text' };
}

function Harness({
  sessionId,
  chatRef,
}: {
  sessionId: string | null;
  chatRef: { current: UseChatStateReturn | undefined };
}) {
  const chat = useChatState({ dbSessionId: sessionId, send: () => true, connected: true });
  chatRef.current = chat;
  // Every committed render, as the composer would paint it.
  useLayoutEffect(() => {
    commits.push({
      sessionId,
      draft: chat.inputDraft,
      attachmentIds: chat.inputAttachments.map((item) => item.id),
    });
  });
  return null;
}

async function mount(initialSessionId: string) {
  const chatRef: { current: UseChatStateReturn | undefined } = { current: undefined };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (sessionId: string | null) => {
    await act(() => root.render(createElement(Harness, { sessionId, chatRef })));
  };
  await render(initialSessionId);
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
  return {
    render,
    get chat() {
      if (!chatRef.current) {
        throw new Error('Hook did not render');
      }
      return chatRef.current;
    },
  };
}

beforeEach(() => {
  sessionStorage.clear();
  commits.length = 0;
});
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });
  sessionStorage.clear();
  vi.useRealTimers();
});

it("never commits the previous session's composer for a newly selected session", async () => {
  persistDraft('session-B', 'Stored B draft');
  persistInputAttachments('session-B', [attachment('b-file')]);
  const harness = await mount('session-A');
  await act(() => {
    harness.chat.setInputDraft('Typed in A');
    harness.chat.setInputAttachments([attachment('a-file')]);
  });

  commits.length = 0;
  await harness.render('session-B');

  const forB = commits.filter((commit) => commit.sessionId === 'session-B');
  expect(forB.length).toBeGreaterThan(0);
  for (const commit of forB) {
    expect(commit).toEqual({
      sessionId: 'session-B',
      draft: 'Stored B draft',
      attachmentIds: ['b-file'],
    });
  }
});

it('restores the typed draft on return without a commit of the sibling draft', async () => {
  const harness = await mount('session-A');
  await act(() => harness.chat.setInputDraft('Still typing in A'));
  await harness.render('session-B');
  commits.length = 0;
  await harness.render('session-A');

  const forA = commits.filter((commit) => commit.sessionId === 'session-A');
  expect(forA.length).toBeGreaterThan(0);
  for (const commit of forA) {
    expect(commit.draft).toBe('Still typing in A');
  }
});
