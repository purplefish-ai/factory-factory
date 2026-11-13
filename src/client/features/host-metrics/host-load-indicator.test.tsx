// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostLoadIndicator, HostLoadIndicatorView } from './host-load-indicator';

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  data: undefined as
    | { samples: { at: number; cpuPercent: number; memoryPercent: number }[] }
    | undefined,
  isMobile: false,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      getHostMetrics: {
        useQuery: (...args: unknown[]) => {
          queryMocks.useQuery(...args);
          return { data: queryMocks.data };
        },
      },
    },
  },
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => queryMocks.isMobile }));

let root: Root | undefined;
afterEach(() => {
  flushSync(() => root?.unmount());
  document.body.innerHTML = '';
  queryMocks.data = undefined;
  queryMocks.isMobile = false;
});

function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root?.render(element));
  return container;
}

const busy = [
  { at: 1, cpuPercent: 97, memoryPercent: 40 },
  { at: 2, cpuPercent: 98, memoryPercent: 41 },
  { at: 3, cpuPercent: 99, memoryPercent: 42 },
];

describe('HostLoadIndicator', () => {
  it('polls host load at the local-status cadence', () => {
    render(createElement(HostLoadIndicator));

    expect(queryMocks.useQuery).toHaveBeenCalledWith(undefined, { refetchInterval: 5000 });
  });

  it('renders nothing until the first sample arrives', () => {
    queryMocks.data = { samples: [] };

    expect(render(createElement(HostLoadIndicator)).childElementCount).toBe(0);
  });

  it('names the current readings for assistive technology', () => {
    queryMocks.data = { samples: busy };

    const button = render(createElement(HostLoadIndicator)).querySelector('button');

    expect(button?.getAttribute('aria-label')).toBe('Computer load: CPU 99%, memory 42%');
    expect(button?.querySelectorAll('svg')).toHaveLength(2);
  });

  it('collapses to a single status light on phones', () => {
    queryMocks.data = { samples: busy };
    queryMocks.isMobile = true;

    const button = render(createElement(HostLoadIndicator)).querySelector('button');

    expect(button?.querySelector('svg')).toBeNull();
    expect(button?.querySelector('[data-status-tone]')?.getAttribute('data-status-tone')).toBe(
      'danger'
    );
  });

  it('shows the numbers when opened', () => {
    const container = render(
      createElement(HostLoadIndicatorView, { samples: busy, compact: true })
    );

    flushSync(() => container.querySelector('button')?.click());

    expect(document.body.textContent).toContain('CPU');
    expect(document.body.textContent).toContain('99%');
    expect(document.body.textContent).toContain('42%');
  });
});
