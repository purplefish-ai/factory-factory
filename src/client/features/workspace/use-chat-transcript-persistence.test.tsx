// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptPosition } from '@/client/features/chat';
import { useChatTranscriptPersistence } from './use-chat-transcript-persistence';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

type Persistence = ReturnType<typeof useChatTranscriptPersistence>;
const reading: TranscriptPosition = {
  intent: 'reading',
  top: 123,
  left: 4,
  anchor: { key: 'row', offset: 8 },
};
const following: TranscriptPosition = { intent: 'following', top: 900, left: 0 };
let current: Persistence;
let renders: { workspaceId: string; ready: boolean; position: TranscriptPosition | null }[];
let root: Root;
let container: HTMLDivElement;
let beforeEffects: (() => void) | undefined;

function Probe({ workspaceId, sessionId }: { workspaceId: string; sessionId: string | null }) {
  current = useChatTranscriptPersistence({ workspaceId, sessionId });
  renders.push({ workspaceId, ready: current.ready, position: current.initialPosition });
  useLayoutEffect(() => beforeEffects?.());
  return null;
}

function PanelProbe({
  onPanel,
}: {
  onPanel: (panel: ReturnType<typeof useWorkspacePanel>) => void;
}) {
  onPanel(useWorkspacePanel());
  return null;
}

async function render(workspaceId = 'a', sessionId: string | null = 'one') {
  await act(() =>
    root.render(
      <WorkspacePanelProvider workspaceId={workspaceId}>
        <Probe workspaceId={workspaceId} sessionId={sessionId} />
      </WorkspacePanelProvider>
    )
  );
}
function seed(workspaceId: string, states: Record<string, unknown>) {
  localStorage.setItem(`workspace-panel-scroll-${workspaceId}`, JSON.stringify({ v: 1, states }));
}
function stored(workspaceId: string) {
  return JSON.parse(
    localStorage.getItem(`workspace-panel-scroll-${workspaceId}`) ?? '{"states":{}}'
  ).states;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  renders = [];
  beforeEffects = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  container.remove();
});

describe('useChatTranscriptPersistence', () => {
  it('waits for reactive workspace readiness and emits committed snapshots under the existing v1 keys', async () => {
    seed('a', { 'chat-one:chat': { top: 9, left: 1, stickToBottom: true } });
    await render();
    expect(renders[0]).toEqual({ workspaceId: 'a', ready: false, position: null });
    expect(current.ready).toBe(true);
    expect(current.initialPosition).toEqual({ intent: 'following', top: 9, left: 1 });
    act(() => current.onPositionChange(reading));
    expect(stored('a')['chat-one:chat'].top).toBe(9);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat']).toMatchObject({
      top: 123,
      left: 4,
      chatPosition: reading,
    });
  });

  it.each([false, undefined])(
    'migrates legacy stickToBottom=%s to reading',
    async (stickToBottom) => {
      seed('a', { 'chat-one:chat': { top: 39, left: 2, stickToBottom } });
      await render();
      expect(current.initialPosition).toEqual({ intent: 'reading', top: 39, left: 2 });
    }
  );

  it('prefers new positions over legacy fields and returns null when no session or record exists', async () => {
    seed('a', { 'chat-one:chat': { top: 9, left: 1, stickToBottom: true, chatPosition: reading } });
    await render();
    expect(current.initialPosition).toEqual(reading);
    await render('a', 'two');
    expect(current.initialPosition).toBeNull();
    await render('a', null);
    expect(current.ready).toBe(false);
    current.onPositionChange(following);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(Object.keys(stored('a'))).toEqual(['chat-one:chat']);
  });

  it('keeps A/B session snapshots separate and revokes old callbacks when selection changes', async () => {
    await render();
    const oldOne = current.onPositionChange;
    act(() => oldOne(reading));
    await render('a', 'two');
    act(() => {
      oldOne(following);
      current.onPositionChange(following);
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat'].chatPosition).toEqual(reading);
    expect(stored('a')['chat-two:chat'].chatPosition).toEqual(following);
    await render('a', 'one');
    act(() => oldOne(following));
    expect(current.initialPosition).toEqual(reading);
  });

  it('flushes A before reading B and rejects stale A callbacks after B loads or A returns', async () => {
    seed('b', { 'chat-one:chat': { top: 900, left: 0, chatPosition: following } });
    await render();
    const oldA = current.onPositionChange;
    act(() => oldA(reading));
    const getItem = Storage.prototype.getItem;
    let aAtBLoad: unknown;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'workspace-panel-scroll-b') {
        aAtBLoad = JSON.parse(getItem.call(this, 'workspace-panel-scroll-a') ?? '{}');
      }
      return getItem.call(this, key);
    });
    await render('b');
    expect(aAtBLoad).toMatchObject({ states: { 'chat-one:chat': { chatPosition: reading } } });
    expect(renders.find((value) => value.workspaceId === 'b')).toEqual({
      workspaceId: 'b',
      ready: false,
      position: null,
    });
    expect(current.initialPosition).toEqual(following);
    act(() => {
      oldA(following);
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat'].chatPosition).toEqual(reading);
    expect(stored('b')['chat-one:chat'].chatPosition).toEqual(following);
    await render('a');
    act(() => oldA(following));
    expect(current.initialPosition).toEqual(reading);
  });

  it('rejects A callbacks during B commit before storage loads', async () => {
    await render();
    const oldA = current.onPositionChange;
    beforeEffects = () => oldA(following);
    await render('b');
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(stored('b')).toEqual({});
    expect(stored('a')).toEqual({});
  });

  it('flushes on unmount and rejects callbacks immediately after cleanup', async () => {
    await render();
    const old = current.onPositionChange;
    act(() => old(reading));
    await act(() => root.unmount());
    old(following);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat'].chatPosition).toEqual(reading);
  });

  it('rejects a removed hook callback while its provider remains mounted', async () => {
    await render();
    const old = current.onPositionChange;
    act(() => old(reading));
    await act(() =>
      root.render(<WorkspacePanelProvider workspaceId="a">{null}</WorkspacePanelProvider>)
    );
    old(following);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat'].chatPosition).toEqual(reading);
  });

  it('accepts committed snapshots after StrictMode effect replay', async () => {
    await act(() =>
      root.render(
        <StrictMode>
          <WorkspacePanelProvider workspaceId="a">
            <Probe workspaceId="a" sessionId="one" />
          </WorkspacePanelProvider>
        </StrictMode>
      )
    );
    expect(current.ready).toBe(true);
    act(() => {
      current.onPositionChange(reading);
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')['chat-one:chat'].chatPosition).toEqual(reading);
  });

  it('revokes a cleared active session before deletion so a late callback cannot recreate it', async () => {
    await render();
    const old = current.onPositionChange;
    act(() => {
      old(reading);
      current.clearSession('one');
      old(following);
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')).toEqual({});
  });

  it('clears inactive B while A remains selected and rejects the late B callback', async () => {
    await render('a', 'two');
    const oldB = current.onPositionChange;
    act(() => oldB(following));
    await render();
    act(() => {
      current.onPositionChange(reading);
      current.clearSession('two');
      oldB(following);
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')).toEqual({
      'chat-one:chat': expect.objectContaining({ chatPosition: reading }),
    });
  });

  it('keeps the workspace close capability usable when session selection changes', async () => {
    await render('a', 'two');
    const closeB = current.clearSession;
    act(() => current.onPositionChange(following));
    await render();
    act(() => {
      current.onPositionChange(reading);
      closeB('two');
      vi.advanceTimersByTime(120);
    });
    expect(stored('a')).toEqual({
      'chat-one:chat': expect.objectContaining({ chatPosition: reading }),
    });
  });

  it('continues with ready empty storage when storage reads or writes throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await render();
    expect(current.ready).toBe(true);
    expect(current.initialPosition).toBeNull();
    expect(() =>
      act(() => {
        current.onPositionChange(reading);
        vi.advanceTimersByTime(120);
      })
    ).not.toThrow();
  });

  it('becomes ready when accessing the localStorage property itself is denied', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    await render();
    expect(current.ready).toBe(true);
    expect(current.initialPosition).toBeNull();
  });
});

it('provider exposes reactive loaded workspace identity and scopes generic viewer callbacks', async () => {
  let panel: ReturnType<typeof useWorkspacePanel> | undefined;
  const loaded: (string | null)[] = [];
  const draw = async (workspaceId: string) =>
    act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId={workspaceId}>
          <PanelProbe
            onPanel={(value) => {
              panel = value;
              loaded.push(value.scrollLoadedWorkspaceId);
            }}
          />
        </WorkspacePanelProvider>
      )
    );
  await draw('a');
  expect(loaded).toEqual(expect.arrayContaining([null, 'a']));
  const old = panel!;
  act(() => old.setScrollState('file', 'markdown', { top: 17, left: 0 }));
  await draw('b');
  expect(panel!.scrollLoadedWorkspaceId).toBe('b');
  expect(old.getScrollState('file', 'markdown')).toBeNull();
  act(() => {
    old.setScrollState('file', 'markdown', { top: 99, left: 0 });
    old.clearScrollState('file');
    vi.advanceTimersByTime(120);
  });
  expect(stored('a')['file:markdown'].top).toBe(17);
  expect(stored('b')).toEqual({});
});
