// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptPosition } from '@/client/features/chat';
import { useQuickChatScroll } from './use-quick-chat-scroll';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

type ScrollMemory = ReturnType<typeof useQuickChatScroll>;
interface ProbeProps {
  workspaceId: string | null;
  sessionId: string | null;
  runtimeSessionId: string | null;
  contentVisible?: boolean;
}

const reading: TranscriptPosition = {
  intent: 'reading',
  top: 140,
  left: 2,
  anchor: { key: 'message-a', offset: 12 },
};
const following: TranscriptPosition = { intent: 'following', top: 700, left: 0 };
const late: TranscriptPosition = { intent: 'reading', top: 999, left: 0 };
let current: ScrollMemory;
let root: Root;
let container: HTMLDivElement;

function Probe({ workspaceId, sessionId, runtimeSessionId, contentVisible = true }: ProbeProps) {
  current = useQuickChatScroll(workspaceId, sessionId, runtimeSessionId);
  return contentVisible ? <output>Transcript content</output> : null;
}

async function render(
  workspaceId: string | null = 'workspace-a',
  sessionId: string | null = 'session-a',
  runtimeSessionId: string | null = sessionId,
  contentVisible = true
) {
  await act(() =>
    root.render(
      <Probe
        workspaceId={workspaceId}
        sessionId={sessionId}
        runtimeSessionId={runtimeSessionId}
        contentVisible={contentVisible}
      />
    )
  );
}

function writer() {
  const callback = current.transcriptScroll.onPositionChange;
  if (!callback) {
    throw new Error('Expected a position callback');
  }
  return callback;
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe('useQuickChatScroll', () => {
  it('keeps independent committed positions across A/B/A session selection', async () => {
    await render();
    expect(current.transcriptScroll).toMatchObject({
      identity: 'workspace-a/quick/session-a',
      active: true,
      ready: true,
      initialIntent: 'following',
      initialPosition: null,
    });
    writer()(reading);
    await render('workspace-a', 'session-b');
    expect(current.transcriptScroll.initialPosition).toBeNull();
    writer()(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
    await render('workspace-a', 'session-b');
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('scopes equal session IDs by workspace across A/B/A workspace selection', async () => {
    await render();
    writer()(reading);
    await render('workspace-b');
    expect(current.transcriptScroll.identity).toBe('workspace-b/quick/session-a');
    expect(current.transcriptScroll.initialPosition).toBeNull();
    writer()(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
    await render('workspace-b');
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('retains positions when sheet content disappears while its hook owner stays mounted', async () => {
    await render();
    writer()(reading);
    await render('workspace-a', 'session-a', 'session-a', false);
    expect(container.querySelector('output')).toBeNull();
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
  });

  it('requires matching runtime snapshot identity before becoming ready', async () => {
    await render('workspace-a', 'session-a', null);
    expect(current.transcriptScroll.ready).toBe(false);
    await render('workspace-a', 'session-a', 'session-b');
    expect(current.transcriptScroll.ready).toBe(false);
    await render('workspace-a', 'session-a', 'session-a');
    expect(current.transcriptScroll.ready).toBe(true);
    await render('workspace-a', 'session-b', 'session-a');
    expect(current.transcriptScroll.ready).toBe(false);
    await render('workspace-a', 'session-b', 'session-b');
    expect(current.transcriptScroll.ready).toBe(true);
    await render('workspace-a', 'session-b', null);
    expect(current.transcriptScroll.ready).toBe(false);
  });

  it.each([
    { workspaceId: null, sessionId: 'session-a', runtimeSessionId: 'session-a', active: false },
    { workspaceId: 'workspace-a', sessionId: null, runtimeSessionId: null, active: true },
    { workspaceId: null, sessionId: null, runtimeSessionId: null, active: false },
  ])('suspends readiness without workspace/session identity: %j', async (identity) => {
    await render(identity.workspaceId, identity.sessionId, identity.runtimeSessionId);
    expect(current.transcriptScroll.ready).toBe(false);
    expect(current.transcriptScroll.active).toBe(identity.active);
  });

  it('rejects old session callbacks while another session is selected', async () => {
    await render();
    const oldA = writer();
    oldA(reading);
    await render('workspace-a', 'session-b');
    oldA(late);
    writer()(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
  });

  it('keeps the same activation callback usable across ordinary owner rerenders', async () => {
    await render();
    const callback = writer();
    callback(reading);
    await render();
    callback(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('keeps old A callbacks revoked after returning to A from another session', async () => {
    await render();
    const oldA = writer();
    oldA(reading);
    await render('workspace-a', 'session-b');
    writer()(following);
    await render();
    oldA(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
    writer()(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('keeps old workspace callbacks revoked after A/B/A workspace selection', async () => {
    await render();
    const oldA = writer();
    oldA(reading);
    await render('workspace-b');
    writer()(following);
    await render();
    oldA(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
  });

  it('clears inactive B while retaining A and rejects B callbacks after returning to B', async () => {
    await render('workspace-a', 'session-b');
    const oldB = writer();
    oldB(following);
    await render();
    writer()(reading);
    current.clearSession('session-b');
    oldB(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
    await render('workspace-a', 'session-b');
    expect(current.transcriptScroll.initialPosition).toBeNull();
    oldB(late);
    await render('workspace-a', 'session-b');
    expect(current.transcriptScroll.initialPosition).toBeNull();
  });

  it('revokes a cleared active session callback immediately before the next render', async () => {
    await render();
    const oldA = writer();
    oldA(reading);
    current.clearSession('session-a');
    oldA(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toBeNull();
    writer()(following);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('clears only the requested workspace/session entry', async () => {
    await render();
    writer()(reading);
    await render('workspace-b');
    writer()(following);
    current.clearSession('session-a');
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(reading);
    await render('workspace-b');
    expect(current.transcriptScroll.initialPosition).toBeNull();
  });

  it('starts a fresh map for a new hook owner and rejects callbacks from its unmounted predecessor', async () => {
    await render();
    const oldA = writer();
    oldA(reading);
    await act(() => root.render(null));
    oldA(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toBeNull();
    writer()(following);
    oldA(late);
    await render();
    expect(current.transcriptScroll.initialPosition).toEqual(following);
  });

  it('keeps scroll memory ephemeral without adding browser storage records', async () => {
    localStorage.setItem('unrelated', 'preserved');
    await render();
    writer()(reading);
    await render('workspace-a', 'session-b');
    writer()(following);
    current.clearSession('session-a');
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('unrelated')).toBe('preserved');
  });
});
