// @vitest-environment jsdom

import { createElement, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToolCallExpansionKey,
  createToolSequenceExpansionKey,
  loadToolExpansionState,
  saveToolExpansionState,
  useWorkspaceToolExpansionState,
} from './tool-expansion-state';

const mockStorage = new Map<string, string>();

const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => mockStorage.set(key, value)),
  removeItem: vi.fn((key: string) => mockStorage.delete(key)),
  clear: vi.fn(() => mockStorage.clear()),
  get length() {
    return mockStorage.size;
  },
  key: vi.fn((index: number) => {
    const keys = Array.from(mockStorage.keys());
    return keys[index] ?? null;
  }),
};

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('localStorage', mockLocalStorage);
  vi.stubGlobal('window', { localStorage: mockLocalStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockStorage.clear();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

function HookHarness({ workspaceId }: { workspaceId?: string }) {
  const { getExpansionState, setExpansionState } = useWorkspaceToolExpansionState(workspaceId);
  const key = 'sequence:tool-seq-1';
  const isOpen = getExpansionState(key, false);

  return createElement(
    'button',
    {
      type: 'button',
      'data-open': isOpen ? 'true' : 'false',
      onClick: () => setExpansionState(key, !isOpen),
    },
    'toggle'
  );
}

function CallbackProbeHarness({
  workspaceId,
  onCallbackRef,
}: {
  workspaceId?: string;
  onCallbackRef: (callback: (key: string, defaultOpen: boolean) => boolean) => void;
}) {
  const { getExpansionState, setExpansionState } = useWorkspaceToolExpansionState(workspaceId);
  const key = 'sequence:tool-seq-1';
  const isOpen = getExpansionState(key, false);

  useEffect(() => {
    onCallbackRef(getExpansionState);
  }, [getExpansionState, onCallbackRef]);

  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => setExpansionState(key, !isOpen),
    },
    'toggle'
  );
}

type HookApi = ReturnType<typeof useWorkspaceToolExpansionState>;

function HookApiHarness({
  workspaceId,
  onApi,
}: {
  workspaceId?: string;
  onApi: (api: HookApi) => void;
}) {
  const api = useWorkspaceToolExpansionState(workspaceId);

  useEffect(() => {
    onApi(api);
  }, [api, onApi]);

  return null;
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('tool expansion keys', () => {
  it('creates stable key formats for sequence and call state', () => {
    expect(createToolSequenceExpansionKey('tool-seq-msg-1')).toBe('sequence:tool-seq-msg-1');
    expect(createToolCallExpansionKey('tool-seq-msg-1', 'call-42')).toBe(
      'call:tool-seq-msg-1:call-42'
    );
  });
});

describe('loadToolExpansionState', () => {
  it('loads stored expansion state when valid', () => {
    mockStorage.set(
      'workspace-tool-call-expansion-workspace-1',
      JSON.stringify({
        'sequence:tool-seq-1': true,
        'call:tool-seq-1:call-1': false,
      })
    );

    expect(loadToolExpansionState('workspace-1')).toEqual({
      'sequence:tool-seq-1': true,
      'call:tool-seq-1:call-1': false,
    });
  });

  it('returns empty state for invalid payloads', () => {
    mockStorage.set('workspace-tool-call-expansion-workspace-1', JSON.stringify(['bad']));
    expect(loadToolExpansionState('workspace-1')).toEqual({});

    mockStorage.set(
      'workspace-tool-call-expansion-workspace-1',
      JSON.stringify({ 'sequence:tool-seq-1': 'true' })
    );
    expect(loadToolExpansionState('workspace-1')).toEqual({});
  });

  it('returns empty state when storage throws', () => {
    mockLocalStorage.getItem.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    expect(loadToolExpansionState('workspace-1')).toEqual({});
  });
});

describe('saveToolExpansionState', () => {
  it('persists expansion state to localStorage', () => {
    saveToolExpansionState('workspace-1', {
      'sequence:tool-seq-1': false,
    });

    expect(mockStorage.get('workspace-tool-call-expansion-workspace-1')).toBe(
      JSON.stringify({ 'sequence:tool-seq-1': false })
    );
  });

  it('silently ignores storage write errors', () => {
    mockLocalStorage.setItem.mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });

    expect(() =>
      saveToolExpansionState('workspace-1', {
        'sequence:tool-seq-1': true,
      })
    ).not.toThrow();
  });
});

describe('useWorkspaceToolExpansionState', () => {
  it('hydrates from storage without immediately overwriting persisted state', async () => {
    const storageKey = 'workspace-tool-call-expansion-workspace-1';
    const initialState = { 'sequence:tool-seq-1': true };
    mockStorage.set(storageKey, JSON.stringify(initialState));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HookHarness, { workspaceId: 'workspace-1' }));
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('data-open')).toBe('true');

    await flushEffects();

    expect(JSON.parse(mockStorage.get(storageKey) ?? '{}')).toEqual(initialState);

    root.unmount();
  });

  it('persists expansion updates after hydration', async () => {
    const storageKey = 'workspace-tool-call-expansion-workspace-1';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HookHarness, { workspaceId: 'workspace-1' }));
    });
    await flushEffects();

    const button = container.querySelector('button');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushEffects();

    expect(JSON.parse(mockStorage.get(storageKey) ?? '{}')).toEqual({
      'sequence:tool-seq-1': true,
    });

    root.unmount();
  });

  it('keeps getExpansionState callback reference stable across toggles', async () => {
    const callbacks: Array<(key: string, defaultOpen: boolean) => boolean> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(CallbackProbeHarness, {
          workspaceId: 'workspace-1',
          onCallbackRef: (callback) => callbacks.push(callback),
        })
      );
    });
    await flushEffects();
    const firstCallback = callbacks.at(-1);

    const button = container.querySelector('button');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushEffects();
    const secondCallback = callbacks.at(-1);

    expect(firstCallback).toBeDefined();
    expect(secondCallback).toBe(firstCallback);

    root.unmount();
  });

  it('prunes old entries when expansion state exceeds the max size', async () => {
    const storageKey = 'workspace-tool-call-expansion-workspace-1';
    let api: HookApi | null = null;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(HookApiHarness, {
          workspaceId: 'workspace-1',
          onApi: (nextApi) => {
            api = nextApi;
          },
        })
      );
    });
    await flushEffects();

    expect(api).not.toBeNull();
    flushSync(() => {
      for (let i = 0; i <= 500; i += 1) {
        api?.setExpansionState(`entry-${i}`, true);
      }
    });
    await flushEffects();

    const storedRaw = mockStorage.get(storageKey);
    expect(storedRaw).toBeTruthy();
    const stored = loadToolExpansionState('workspace-1');
    expect(Object.keys(stored)).toHaveLength(500);
    expect(stored['entry-0']).toBeUndefined();
    expect(stored['entry-500']).toBe(true);

    root.unmount();
  });
});
