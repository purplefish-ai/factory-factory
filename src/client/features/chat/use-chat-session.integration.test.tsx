// @vitest-environment jsdom

import { act, createElement, useReducer, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatAction, type ChatState, chatReducer, createInitialChatState } from './reducer';
import { createToolInputAccumulatorState } from './streaming-utils';
import { useChatSession } from './use-chat-session';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});
type SessionState = { state: ChatState; dispatch: React.Dispatch<ChatAction> };
const cleanups: (() => void)[] = [];

function SessionHarness({
  sessionId,
  stateRef,
}: {
  sessionId: string | null;
  stateRef: { current: SessionState | null };
}) {
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState);
  const toolInputAccumulatorRef = useRef(createToolInputAccumulatorState());
  useChatSession({
    dbSessionId: sessionId,
    dispatch,
    toolInputAccumulatorRef,
    sessionRuntimePhase: state.sessionRuntime.phase,
  });
  stateRef.current = { state, dispatch };
  return null;
}

async function mount(initialSessionId: string | null) {
  const stateRef: { current: SessionState | null } = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (sessionId: string | null) => {
    await act(() => root.render(createElement(SessionHarness, { sessionId, stateRef })));
  };
  await render(initialSessionId);
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
  return {
    render,
    get session() {
      if (!stateRef.current) {
        throw new Error('Hook did not render');
      }
      return stateRef.current;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });
  vi.useRealTimers();
  sessionStorage.clear();
});

describe('session loading safety timeout', () => {
  it('arms the timeout for Quick Chat when null becomes a newly created session', async () => {
    const harness = await mount(null);
    await act(() =>
      harness.session.dispatch({ type: 'UPDATE_SETTINGS', payload: { selectedModel: 'opus' } })
    );
    await harness.render('created-quick-chat');
    expect(harness.session.state.modelSelectionSource).toBe('bootstrap');
    expect(harness.session.state.sessionStatus.phase).toBe('loading');
    await act(() => vi.advanceTimersByTime(10_000));
    expect(harness.session.state.sessionStatus.phase).toBe('ready');
  });

  it('restarts the timeout for the newly selected session', async () => {
    const harness = await mount('session-A');
    await act(() => vi.advanceTimersByTime(9000));
    await harness.render('session-B');
    await act(() => vi.advanceTimersByTime(1000));
    expect(harness.session.state.sessionStatus.phase).toBe('loading');
    await act(() => vi.advanceTimersByTime(9000));
    expect(harness.session.state.sessionStatus.phase).toBe('ready');
  });

  it('cancels the safety timeout when the session finishes loading', async () => {
    const harness = await mount('session-A');
    expect(vi.getTimerCount()).toBe(1);
    await act(() => harness.session.dispatch({ type: 'SESSION_LOADING_END' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
