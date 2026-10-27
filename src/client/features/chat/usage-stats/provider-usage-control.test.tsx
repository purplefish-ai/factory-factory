// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyTokenStats } from '@/lib/chat-protocol';
import type { ProviderPlanUsage } from '@/shared/provider-usage';
import {
  ProviderUsageControl,
  UsageControl,
  type UsageControlProps,
} from './provider-usage-control';

const queryMocks = vi.hoisted(() => ({ useQuery: vi.fn(), refetch: vi.fn(async () => undefined) }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      getProviderUsage: {
        useQuery: (...args: unknown[]) => {
          queryMocks.useQuery(...args);
          return { data: plan, isFetching: false, isError: false, refetch: queryMocks.refetch };
        },
      },
    },
  },
}));

const plan: ProviderPlanUsage = {
  provider: 'CLAUDE',
  status: 'available',
  updatedAt: '2026-10-27T12:00:00Z',
  windows: [{ id: 'session', label: '5-hour limit', usedPercent: 94, resetsAt: 1_793_102_400 }],
};
let root: Root | undefined;
afterEach(() => {
  flushSync(() => root?.unmount());
  document.body.innerHTML = '';
});
function render(overrides: Partial<UsageControlProps> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props: UsageControlProps = {
    tokenStats: {
      ...createEmptyTokenStats(),
      inputTokens: 900_000,
      contextUsedTokens: 40_000,
      contextWindow: 200_000,
    },
    planUsage: plan,
    onCompact: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  flushSync(() => root?.render(createElement(UsageControl, props)));
  return props;
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label
  );
  if (!found) {
    throw new Error(`Missing button ${label}`);
  }
  return found;
}
function click(element: HTMLElement) {
  flushSync(() => element.click());
}

describe('Combined usage control', () => {
  it('uses current occupancy and shows account warning and reset details', () => {
    render();
    expect(button('Usage: 20% context, plan limit nearly reached').textContent).toContain('20%');
    click(button('Usage: 20% context, plan limit nearly reached'));
    expect(document.body.textContent).toContain('40,000 / 200,000 tokens');
    expect(document.body.textContent).toContain('5-hour limit');
    expect(document.body.textContent).toContain('94%');
    expect(document.body.textContent).toContain('Resets');
    expect(document.body.textContent).toContain('Updated');
  });
  it('keeps unavailable context explicit and disables compaction despite cumulative totals', () => {
    render({
      tokenStats: { ...createEmptyTokenStats(), inputTokens: 900_000, contextWindow: 200_000 },
      planUsage: undefined,
    });
    click(button('Usage'));
    expect(document.body.textContent).toContain('Context unavailable');
    expect(button('Compact').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('0%');
  });
  it('allows compacting a known zero snapshot and dispatches only the compact action', () => {
    const props = render({
      tokenStats: { ...createEmptyTokenStats(), contextUsedTokens: 0, contextWindow: 200_000 },
    });
    click(button('Usage: 0% context, plan limit nearly reached'));
    click(button('Compact'));
    expect(props.onCompact).toHaveBeenCalledOnce();
  });
  it.each(['busy', 'disabled', 'compacting'] as const)('disables compaction when %s', (state) => {
    render({ [state]: true });
    click(button('Usage: 20% context, plan limit nearly reached'));
    expect(button(state === 'compacting' ? 'Compacting…' : 'Compact').disabled).toBe(true);
    if (state === 'compacting') {
      expect(document.querySelector('[role="status"]')?.textContent).toContain('Compacting');
    }
  });
  it('shows missing plan readings as unavailable and supports refresh', () => {
    const props = render({
      planUsage: {
        ...plan,
        status: 'unavailable',
        windows: [],
        message: 'Sign in to read plan limits.',
      },
    });
    click(button('Usage: 20% context'));
    expect(document.body.textContent).toContain('Sign in to read plan limits.');
    expect(document.body.textContent).not.toContain('94%');
    click(button('Refresh usage'));
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
});

it('polls account limits only while the popover is open and refreshes after work ends', () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props = { provider: 'CLAUDE' as const, onCompact: vi.fn(), busy: true };
  flushSync(() => root?.render(createElement(ProviderUsageControl, props)));
  expect(queryMocks.useQuery).toHaveBeenLastCalledWith(
    { provider: 'CLAUDE' },
    expect.objectContaining({ refetchInterval: false })
  );
  click(button('Usage, plan limit nearly reached'));
  expect(queryMocks.useQuery).toHaveBeenLastCalledWith(
    { provider: 'CLAUDE' },
    expect.objectContaining({ refetchInterval: 30_000 })
  );
  click(button('Usage, plan limit nearly reached'));
  expect(queryMocks.useQuery).toHaveBeenLastCalledWith(
    { provider: 'CLAUDE' },
    expect.objectContaining({ refetchInterval: false })
  );
  queryMocks.refetch.mockClear();
  flushSync(() => root?.render(createElement(ProviderUsageControl, { ...props, busy: false })));
  expect(queryMocks.refetch).toHaveBeenCalledOnce();
});
