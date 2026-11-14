// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostLoadIndicator, HostLoadIndicatorView } from './host-load-indicator';

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useBreakdownQuery: vi.fn(),
  data: undefined as
    | { samples: { at: number; cpuPercent: number; memoryPercent: number }[] }
    | undefined,
  isMobile: false,
  breakdown: undefined as unknown,
  breakdownError: false,
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
      getHostLoadBreakdown: {
        useQuery: (...args: unknown[]) => {
          queryMocks.useBreakdownQuery(...args);
          return { data: queryMocks.breakdown, isError: queryMocks.breakdownError };
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
  queryMocks.breakdown = undefined;
  queryMocks.breakdownError = false;
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

  it('reads the process breakdown only while the details are open', () => {
    queryMocks.data = { samples: busy };
    const container = render(createElement(HostLoadIndicator));

    expect(queryMocks.useBreakdownQuery).toHaveBeenLastCalledWith(undefined, {
      enabled: false,
      refetchInterval: 5000,
    });

    flushSync(() => container.querySelector('button')?.click());

    expect(queryMocks.useBreakdownQuery).toHaveBeenLastCalledWith(undefined, {
      enabled: true,
      refetchInterval: 5000,
    });
  });

  it('shows the breakdown the query returns once opened', () => {
    queryMocks.data = { samples: busy };
    queryMocks.breakdown = {
      byCpu: [
        {
          key: 'app:Google Chrome',
          label: 'Google Chrome',
          kind: 'app',
          workspace: null,
          cpuPercent: 41,
          memoryBytes: 1024,
          processCount: 30,
        },
      ],
      byMemory: [],
    };
    const container = render(createElement(MemoryRouter, null, createElement(HostLoadIndicator)));

    flushSync(() => container.querySelector('button')?.click());

    expect(document.body.textContent).toContain('Google Chrome41%');
  });

  it('says so when the process list cannot be read, instead of loading forever', () => {
    queryMocks.data = { samples: busy };
    queryMocks.breakdownError = true;
    const container = render(createElement(HostLoadIndicator));

    flushSync(() => container.querySelector('button')?.click());

    expect(document.body.textContent).toContain('Could not read the process list');
  });

  it('renders nothing until the first sample arrives', () => {
    queryMocks.data = { samples: [] };

    expect(render(createElement(HostLoadIndicator)).childElementCount).toBe(0);
  });

  it('names the current readings for assistive technology', () => {
    queryMocks.data = { samples: busy };

    const button = render(createElement(HostLoadIndicator)).querySelector('button');

    expect(button?.getAttribute('aria-label')).toBe('Computer load: CPU 99%, memory 42%');
  });

  it('shows both readings on one line with a level bar each, on desktop and on phones', () => {
    for (const isMobile of [false, true]) {
      queryMocks.data = { samples: busy };
      queryMocks.isMobile = isMobile;

      const button = render(createElement(HostLoadIndicator)).querySelector('button');

      const readings = [...(button?.querySelectorAll('[data-slot="host-load-value"]') ?? [])].map(
        (value) => value.textContent
      );
      expect(readings).toEqual(['99%', '42%']);
      expect(button?.querySelectorAll('[data-slot="host-load-level"]')).toHaveLength(2);
      flushSync(() => root?.unmount());
    }
  });

  it('keeps each reading in its own hue until it is overloaded', () => {
    const button = render(
      createElement(HostLoadIndicatorView, { samples: busy, compact: false })
    ).querySelector('button');

    expect(button?.getAttribute('data-status-tone')).toBe('danger');
    expect(button?.querySelector('[data-metric="cpu"]')?.className).toContain('text-destructive');
    expect(button?.querySelector('[data-metric="memory"]')?.className).toContain('text-success');
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

  it('names what is using the machine, linking workspaces', () => {
    const group = {
      kind: 'app' as const,
      workspace: null,
      cpuPercent: 41,
      memoryBytes: 2 * 1024 ** 3,
      processCount: 30,
    };
    const workspace = {
      ...group,
      key: 'workspace:w1',
      label: 'Fix login',
      kind: 'workspace' as const,
      workspace: { id: 'w1', projectSlug: 'repo' },
    };
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(HostLoadIndicatorView, {
          samples: busy,
          compact: false,
          open: true,
          breakdown: {
            byCpu: [{ ...group, key: 'app:Google Chrome', label: 'Google Chrome' }, workspace],
            byMemory: [workspace],
          },
        })
      )
    );

    expect(document.body.textContent).toContain('Google Chrome41%');
    expect(document.body.textContent).toContain('2.0 GB');
    expect(document.body.querySelector('a[href="/projects/repo/workspaces/w1"]')?.textContent).toBe(
      'Fix login'
    );
  });
});
