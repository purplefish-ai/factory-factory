// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';
import { ProviderSubagentsSection } from './provider-subagents-section';
import type { SubagentListItem } from './types';

function child(id: string): SubagentListItem {
  return {
    id,
    name: id,
    status: 'running',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    latestActivity: null,
    resultPreview: null,
  };
}

describe('live sub-agent list invalidation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it('refreshes infinite-query rows on spawn and completion events without refreshing other sessions', async () => {
    const first = child('First agent');
    const second = child('Second agent');
    const responses: Record<string, SubagentListItem[]> = {
      'session-a': [first],
      'session-b': [child('Other session agent')],
    };
    const client = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path !== 'session.listSubagents') {
                observer.error(new TRPCClientError(`Unexpected query: ${op.path}`));
                return;
              }
              const { sessionId } = z.object({ sessionId: z.string() }).parse(op.input);
              observer.next({
                result: {
                  data: {
                    supported: true,
                    subagents: responses[sessionId] ?? [],
                    nextCursor: null,
                  },
                },
              });
              observer.complete();
            }),
      ],
    });
    await act(async () =>
      root.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            {['session-a', 'session-b'].map((sessionId) => (
              <div key={sessionId} data-session={sessionId}>
                <ProviderSubagentsSection
                  sessionId={sessionId}
                  parentSessionName={sessionId}
                  enabled
                  onSelect={vi.fn()}
                />
              </div>
            ))}
          </QueryClientProvider>
        </trpc.Provider>
      )
    );

    async function expectCounts(firstCount: number, secondCount: number) {
      await vi.waitFor(
        async () => {
          // Flush React Query's scheduled observer notifications inside act.
          await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
          expect(
            container.querySelector('[data-session="session-a"] [aria-label="Active sub-agents"]')
              ?.textContent
          ).toBe(String(firstCount));
          expect(
            container.querySelector('[data-session="session-b"] [aria-label="Active sub-agents"]')
              ?.textContent
          ).toBe(String(secondCount));
        },
        { timeout: 2000 }
      );
    }
    await expectCounts(1, 1);

    responses['session-a'] = [first, second];
    responses['session-b'] = [child('Other session agent'), child('Unannounced agent')];
    await act(async () =>
      dispatchSubagentChange({ sessionId: 'session-a', subagentId: second.id, change: 'created' })
    );
    await expectCounts(2, 1);
    expect(container.querySelector('[data-session="session-a"]')?.textContent).toContain(
      'Second agent'
    );

    responses['session-a'] = [{ ...first, status: 'completed' }, second];
    await act(async () =>
      dispatchSubagentChange({ sessionId: 'session-a', subagentId: first.id, change: 'completed' })
    );
    await expectCounts(1, 1);
    expect(container.querySelector('[data-session="session-a"]')?.textContent).toContain(
      'Completed · 1'
    );
  });
});
