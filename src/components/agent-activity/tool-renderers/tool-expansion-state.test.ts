// @vitest-environment jsdom

import { createElement } from 'react';
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
});
