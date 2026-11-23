// @vitest-environment jsdom

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppQueryClient } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { HostLoadIndicator, HostLoadIndicatorView } from './host-load-indicator';

const env = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => env.isMobile }));

interface Sample {
  at: number;
  cpuPercent: number;
  memoryPercent: number;
}

const sample = (at: number, cpuPercent = 10, memoryPercent = 30): Sample => ({
  at,
  cpuPercent,
  memoryPercent,
});

const busy = [sample(1, 97, 40), sample(2, 98, 41), sample(3, 99, 42)];

const cursorSchema = z.object({ after: z.number() }).optional();

/**
 * A fake backend that answers `admin.getHostMetrics` as the server does: only
 * the samples after a cursor it still holds, otherwise its whole window.
 */
function createHostServer(initial: Sample[]) {
  const server = {
    window: initial,
    requests: [] as Array<{ path: string; input: unknown }>,
    /** Leave host metrics requests unanswered while set. */
    holdMetrics: false,
    breakdown: undefined as unknown,
    breakdownFails: false,
    take(next: Sample) {
      server.window = [...server.window, next].slice(-60);
    },
    restart(fresh: Sample[]) {
      server.window = fresh;
    },
    metricsRequests() {
      return server.requests.filter((request) => request.path === 'admin.getHostMetrics');
    },
    breakdownRequests() {
      return server.requests.filter((request) => request.path === 'admin.getHostLoadBreakdown');
    },
  };
  const historyAfter = (input: unknown) => {
    const after = cursorSchema.parse(input)?.after;
    const cursor = server.window.findIndex((entry) => entry.at === after);
    const oldestAt = server.window[0]?.at ?? 0;
    return after !== undefined && cursor !== -1
      ? { samples: server.window.slice(cursor + 1), since: after, oldestAt }
      : { samples: server.window, since: null, oldestAt };
  };
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            server.requests.push({ path: op.path, input: op.input });
            if (op.path === 'admin.getHostMetrics') {
              if (!server.holdMetrics) {
                observer.next({ result: { data: historyAfter(op.input) } });
                observer.complete();
              }
              return;
            }
            if (server.breakdownFails) {
              observer.error(new TRPCClientError('ps failed'));
              return;
            }
            observer.next({ result: { data: server.breakdown } });
            observer.complete();
          }),
    ],
  });
  return Object.assign(server, { client });
}

let root: Root | undefined;
let queryClient: QueryClient | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  document.body.innerHTML = '';
  env.isMobile = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Lets React Query's timers and React run for `ms` of fake time, then a few
 * turns more, so a poll fired at the end commits and renders. Fake timers run
 * a zero-delay timeout one millisecond later, as Node does.
 */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function renderIndicator(server: ReturnType<typeof createHostServer>) {
  const client = createAppQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  queryClient = client;
  const container = render(
    <trpc.Provider client={server.client} queryClient={client}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HostLoadIndicator />
        </MemoryRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
  await tick();
  return container;
}

const label = (container: HTMLElement) =>
  container.querySelector('button')?.getAttribute('aria-label');

async function open(container: HTMLElement) {
  act(() => container.querySelector('button')?.click());
  await tick();
}

describe('HostLoadIndicator', () => {
  it('asks only for samples newer than its latest one after the first poll', async () => {
    const server = createHostServer([sample(0), sample(5000), sample(10_000)]);
    const container = await renderIndicator(server);

    server.take(sample(15_000, 55, 44));
    await tick(5000);

    expect(server.metricsRequests().map((request) => request.input)).toEqual([
      undefined,
      { after: 10_000 },
    ]);
    expect(label(container)).toBe('Computer load: CPU 55%, memory 44%');

    server.take(sample(20_000, 60, 45));
    await tick(5000);

    expect(server.metricsRequests().at(-1)?.input).toEqual({ after: 15_000 });
    expect(label(container)).toBe('Computer load: CPU 60%, memory 45%');
  });

  it('starts over from the whole window after the server restarted', async () => {
    const server = createHostServer([sample(200_000, 90), sample(205_000, 90)]);
    const container = await renderIndicator(server);

    server.restart([sample(100_000, 7, 20)]);
    await tick(5000);
    server.take(sample(105_000, 8, 21));
    await tick(5000);

    expect(server.metricsRequests().map((request) => request.input)).toEqual([
      undefined,
      { after: 205_000 },
      { after: 100_000 },
    ]);
    expect(label(container)).toBe('Computer load: CPU 8%, memory 21%');
  });

  it('polls every 5 seconds on desktop', async () => {
    const server = createHostServer([sample(0)]);
    await renderIndicator(server);

    await tick(15_000);

    expect(server.metricsRequests()).toHaveLength(4);
  });

  it('polls every 15 seconds on a phone, and every 5 while the details are open', async () => {
    env.isMobile = true;
    const server = createHostServer([sample(0)]);
    const container = await renderIndicator(server);

    await tick(5000);
    expect(server.metricsRequests()).toHaveLength(1);
    await tick(10_000);
    expect(server.metricsRequests()).toHaveLength(2);

    await open(container);
    await tick(5000);

    expect(server.metricsRequests()).toHaveLength(3);
  });

  it('reads the process breakdown only while the details are open, every 5 seconds', async () => {
    const server = createHostServer(busy);
    const container = await renderIndicator(server);
    await tick(5000);

    expect(server.breakdownRequests()).toHaveLength(0);

    await open(container);
    expect(server.breakdownRequests()).toHaveLength(1);
    await tick(5000);
    expect(server.breakdownRequests()).toHaveLength(2);
  });

  it('shows the breakdown the query returns once opened', async () => {
    const server = createHostServer(busy);
    server.breakdown = {
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
    const container = await renderIndicator(server);

    await open(container);

    expect(document.body.textContent).toContain('Google Chrome41%');
  });

  it('says so when the process list cannot be read, instead of loading forever', async () => {
    const server = createHostServer(busy);
    server.breakdownFails = true;
    const container = await renderIndicator(server);

    await open(container);

    expect(document.body.textContent).toContain('Could not read the process list');
  });

  it('renders nothing until the first sample arrives', async () => {
    const server = createHostServer(busy);
    server.holdMetrics = true;

    expect((await renderIndicator(server)).childElementCount).toBe(0);
  });

  it('names the current readings for assistive technology', async () => {
    const container = await renderIndicator(createHostServer(busy));

    expect(label(container)).toBe('Computer load: CPU 99%, memory 42%');
  });

  it('shows both readings on one line with a level bar each, on desktop and on phones', async () => {
    for (const isMobile of [false, true]) {
      env.isMobile = isMobile;

      const button = (await renderIndicator(createHostServer(busy))).querySelector('button');

      const readings = [...(button?.querySelectorAll('[data-slot="host-load-value"]') ?? [])].map(
        (value) => value.textContent
      );
      expect(readings).toEqual(['99%', '42%']);
      expect(button?.querySelectorAll('[data-slot="host-load-level"]')).toHaveLength(2);
      act(() => root?.unmount());
      queryClient?.clear();
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

    act(() => container.querySelector('button')?.click());

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
