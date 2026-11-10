import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
// @vitest-environment jsdom
import type { inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc, type AppRouter } from '@/client/lib/trpc';
import { parseClosedSessionReadTranscript } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';
import { ClosedSessionTranscriptView } from './closed-session-transcript-view';

type Wire = inferRouterOutputs<AppRouter>['closedSessions']['getTranscriptJson'];
let mounted: Root | undefined;
const queryClients: QueryClient[] = [];
afterEach(() => {
  mounted?.unmount();
  queryClients.splice(0).forEach((client) => client.clear());
  document.body.innerHTML = '';
});
function renderWire(wire: unknown, error?: TRPCClientError<AppRouter>) {
  const response: { wire: unknown; error?: TRPCClientError<AppRouter> } = { wire, error };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'closedSessions.getTranscriptJson') {
              observer.error(new TRPCClientError(`Unexpected operation: ${op.path}`));
            } else if (response.error) {
              observer.error(response.error);
            } else if (response.wire !== undefined) {
              observer.next({ result: { data: response.wire } });
              observer.complete();
            }
          }),
    ],
  });
  const container = document.createElement('div');
  document.body.append(container);
  mounted = createRoot(container);
  const renderSession = (sessionId: string) =>
    flushSync(() =>
      mounted?.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ClosedSessionTranscriptView sessionId={sessionId} />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
  renderSession('closed');
  return { container, response, queryClient, client, renderSession };
}
async function render(messages: unknown[]) {
  const wire: Wire = JSON.stringify({ messages });
  const fixture = renderWire(wire);
  await vi.waitFor(() =>
    expect(fixture.container.textContent).not.toContain('Loading transcript…')
  );
  return fixture.container;
}
const user = (text: string, extra = {}) => ({
  id: 'duplicate',
  source: 'user',
  timestamp: '',
  order: 0,
  text,
  ...extra,
});
const tool = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: '/example.txt' },
});
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` });
const agent = (id: string, content: unknown[]) => ({
  id,
  source: 'agent',
  timestamp: '',
  order: 0,
  message: { type: 'assistant', message: { role: 'assistant', content } },
});
const rawPre = (container: Element) =>
  [...container.querySelectorAll('section[aria-label="Archived message JSON"] pre')].map(
    (node) => node.textContent
  );

const staleNotice = "Couldn't refresh. Showing the last loaded data.";
const failureKinds = ['network', 'server', 'malformed', 'schema'] as const;
function readFailure(kind: (typeof failureKinds)[number]): {
  wire?: unknown;
  error?: TRPCClientError<AppRouter>;
} {
  if (kind === 'network') {
    return { error: new TRPCClientError<AppRouter>('Synthetic connection failure') };
  }
  if (kind === 'server') {
    return {
      error: TRPCClientError.from<AppRouter>({
        error: {
          code: -32_603,
          message: 'Failed to read transcript file',
          data: { code: 'INTERNAL_SERVER_ERROR' },
        },
      }),
    };
  }
  return {
    wire:
      kind === 'malformed'
        ? 'new-invalid-wire is not JSON'
        : '{"messages":false,"invalidNewWireMarker":"must not render"}',
  };
}
function failRead(fixture: ReturnType<typeof renderWire>, kind: (typeof failureKinds)[number]) {
  Object.assign(fixture.response, readFailure(kind));
}

describe('compatible archive view with real query selection, projection and rich renderer', () => {
  it('retains the loading state while its query has no response', () => {
    expect(renderWire(undefined).container.textContent).toContain('Loading transcript…');
  });

  it('retains the empty state for a valid empty messages array', async () => {
    expect((await render([])).textContent).toContain('No messages in this session');
  });

  it('retains the explicit NOT_FOUND state', async () => {
    const fixture = renderWire(
      undefined,
      TRPCClientError.from<AppRouter>({
        error: { code: -32_004, message: 'Missing archive', data: { code: 'NOT_FOUND' } },
      })
    );
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('Transcript not found'));
  });

  it('shows NOT_FOUND after a cached success rather than stale content', async () => {
    const fixture = renderWire(JSON.stringify({ messages: [user('previous valid')] }));
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('previous valid'));
    fixture.response.error = TRPCClientError.from<AppRouter>({
      error: { code: -32_004, message: 'Missing archive', data: { code: 'NOT_FOUND' } },
    });
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('Transcript not found'));
    expect(fixture.container.textContent).not.toContain('previous valid');
  });

  it('keeps rich/opaque/orphan order and escapes full hostile raw JSON as text', async () => {
    const hostile = {
      role: 'future',
      nested: { text: '<script>alert(1)</script><img src=x onerror=alert(2)>', keep: [null, 7] },
    };
    const orphan = agent('orphan', [result('A')]);
    const container = await render([
      user('first rich'),
      agent('call', [tool('A')]),
      hostile,
      orphan,
      user('last rich'),
    ]);
    expect(rawPre(container)).toEqual([
      JSON.stringify(hostile, null, 2),
      JSON.stringify(orphan, null, 2),
    ]);
    expect(container.querySelector('script,img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;script&gt;');
    expect(container.textContent?.indexOf('first rich')).toBeLessThan(
      container.textContent?.indexOf('future') ?? 0
    );
    expect(container.textContent?.indexOf('future')).toBeLessThan(
      container.textContent?.indexOf('orphan') ?? 0
    );
    expect(container.textContent?.indexOf('orphan')).toBeLessThan(
      container.textContent?.indexOf('last rich') ?? 0
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it.each(['adjacent', 'late'])(
    'keeps an entire %s multi-result row once after rich content',
    async (mode) => {
      const mixed = agent('mixed', [result('A'), result('B')]);
      const container = await render([
        agent('call', [tool('A')]),
        ...(mode === 'late' ? [user('between rich')] : []),
        mixed,
        user('after rich'),
      ]);
      expect(rawPre(container)).toEqual([JSON.stringify(mixed, null, 2)]);
      expect(container.textContent?.indexOf('Read')).toBeLessThan(
        container.textContent?.indexOf('mixed') ?? 0
      );
      expect(container.textContent?.indexOf('mixed')).toBeLessThan(
        container.textContent?.indexOf('after rich') ?? 0
      );
    }
  );

  it('renders a same-index current rich item before its complete orphan fallback', async () => {
    const mixed = agent('mixed', [tool('B'), result('unknown')]);
    const container = await render([mixed]);
    expect(container.textContent?.indexOf('Read')).toBeLessThan(
      container.textContent?.indexOf('mixed') ?? 0
    );
    expect(rawPre(container)).toEqual([JSON.stringify(mixed, null, 2)]);
  });

  it('keeps current undeclared extras rich-only and invalid-known rows opaque', async () => {
    const invalid = { ...user('invalid'), order: 'not numeric', extra: { keep: true } };
    const container = await render([
      user('current rich', { extension: 'not shown' }),
      invalid,
      null,
      3,
      ['legacy'],
    ]);
    expect(container.textContent).toContain('current rich');
    expect(container.textContent).not.toContain('not shown');
    expect(rawPre(container)).toEqual(
      [invalid, null, 3, ['legacy']].map((value) => JSON.stringify(value, null, 2))
    );
  });

  it('preserves own reserved fallback fields after a changed response in the same mounted view', async () => {
    const row = (revision: number) =>
      `{"role":"future","__proto__":{"archiveSentinel":"row-${revision}"},"constructor":${revision},"prototype":true,"changed":${revision},"nested":{"__proto__":{"archiveSentinel":"nested-${revision}"},"changed":${revision}}}`;
    const wire = (revision: number) =>
      `{"__proto__":{"archiveSentinel":"envelope-${revision}"},"changed":${revision},"messages":[${row(revision)}]}`;
    const fixture = renderWire(wire(1));
    for (const revision of [1, 2]) {
      if (revision === 2) {
        fixture.response.wire = wire(revision);
        await fixture.queryClient.refetchQueries();
      }
      const expected: unknown = JSON.parse(row(revision));
      await vi.waitFor(() =>
        expect(rawPre(fixture.container)).toEqual([JSON.stringify(expected, null, 2)])
      );
      expect(Reflect.has(Object.prototype, 'archiveSentinel')).toBe(false);
    }
  });

  it.each(failureKinds)(
    'keeps validated rich/raw history with a visible %s read failure, then recovers',
    async (kind) => {
      const opaque = {
        role: 'legacy',
        nested: { kept: [true, null], text: '<script>archived</script>' },
      };
      const fixture = renderWire(JSON.stringify({ messages: [user('previous valid'), opaque] }));
      await vi.waitFor(() => expect(fixture.container.textContent).toContain('previous valid'));
      const observer = new QueryObserver(fixture.queryClient, {
        queryKey: getQueryKey(trpc.closedSessions.getTranscriptJson, { id: 'closed' }, 'query'),
        queryFn: () => fixture.client.closedSessions.getTranscriptJson.query({ id: 'closed' }),
        select: parseClosedSessionReadTranscript,
        structuralSharing: false,
        retry: false,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        const initial = await observer.refetch({ throwOnError: true });
        failRead(fixture, kind);
        const failed = await observer.refetch();
        expect(failed.isError).toBe(true);
        expect(failed.data).toBe(initial.data);
        // React's external-store snapshot must stay stable when only time changes.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(failed.errorUpdatedAt + 1);
        try {
          observer.updateResult();
          expect(observer.getCurrentResult()).toBe(failed);
        } finally {
          clock.mockRestore();
        }
        await vi.waitFor(() =>
          expect(fixture.container.querySelector('[role="status"] p')?.textContent).toBe(
            staleNotice
          )
        );
        expect(fixture.container.querySelectorAll('[role="status"]')).toHaveLength(1);
        expect(fixture.container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe(
          'polite'
        );
        expect(fixture.container.textContent).toContain('previous valid');
        expect(rawPre(fixture.container)).toEqual([JSON.stringify(opaque, null, 2)]);
        expect(fixture.container.querySelector('script')).toBeNull();
        expect(fixture.container.textContent).not.toContain('new-invalid-wire');
        expect(fixture.container.textContent).not.toContain('invalidNewWireMarker');
        expect(fixture.container.textContent).not.toContain('Transcript not found');
        fixture.response.error = undefined;
        fixture.response.wire = JSON.stringify({ messages: [user('recovered valid')] });
        await observer.refetch({ throwOnError: true });
        await vi.waitFor(() => expect(fixture.container.textContent).toContain('recovered valid'));
        expect(fixture.container.querySelector('[role="status"]')).toBeNull();
        expect(fixture.container.textContent).not.toContain('previous valid');
      } finally {
        unsubscribe();
        observer.destroy();
      }
    }
  );

  it.each(failureKinds)('keeps validated empty history with a visible %s failure', async (kind) => {
    const fixture = renderWire(JSON.stringify({ messages: [] }));
    await vi.waitFor(() =>
      expect(fixture.container.textContent).toContain('No messages in this session')
    );
    failRead(fixture, kind);
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() =>
      expect(fixture.container.querySelector('[role="status"] p')?.textContent).toBe(staleNotice)
    );
    expect(fixture.container.textContent).toContain('No messages in this session');
    fixture.response.error = undefined;
    fixture.response.wire = JSON.stringify({ messages: [] });
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() => expect(fixture.container.querySelector('[role="status"]')).toBeNull());
    expect(fixture.container.textContent).toContain('No messages in this session');
  });

  it.each(failureKinds)(
    'keeps the generic failure without a prior validated DTO: %s',
    async (kind) => {
      const failure = readFailure(kind);
      const fixture = renderWire(failure.wire, failure.error);
      await vi.waitFor(() =>
        expect(fixture.container.textContent).toContain("Couldn't load transcript")
      );
      expect(fixture.container.querySelector('[role="status"]')).toBeNull();
      expect(rawPre(fixture.container)).toEqual([]);
      expect(fixture.container.textContent).not.toContain('new-invalid-wire');
      expect(fixture.container.textContent).not.toContain('invalidNewWireMarker');
    }
  );

  it('keeps cached history and its notice isolated from a new session query key', async () => {
    const previousWire = JSON.stringify({ messages: [user('previous session')] });
    const fixture = renderWire(previousWire);
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('previous session'));
    failRead(fixture, 'network');
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() =>
      expect(fixture.container.querySelector('[role="status"] p')?.textContent).toBe(staleNotice)
    );
    fixture.response.error = undefined;
    fixture.response.wire = JSON.stringify({ messages: [user('new session')] });
    fixture.renderSession('different-session');
    expect(fixture.container.textContent).not.toContain('previous session');
    // The new session's loading state is a status region too; the stale notice must not carry over.
    expect(fixture.container.textContent).not.toContain(staleNotice);
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('new session'));
    expect(
      fixture.queryClient.getQueryData(
        getQueryKey(trpc.closedSessions.getTranscriptJson, { id: 'closed' }, 'query')
      )
    ).toBe(previousWire);
  });

  it('preserves its viewport, focused control and scroll on failure, and auto-scrolls valid recovery', async () => {
    const fixture = renderWire(
      JSON.stringify({ messages: [user('history'), agent('call', [tool('A')])] })
    );
    await vi.waitFor(() => expect(fixture.container.querySelector('button')).not.toBeNull());
    const viewport = fixture.container.querySelector<HTMLDivElement>(
      '[data-radix-scroll-area-viewport]'
    );
    const control = fixture.container.querySelector<HTMLButtonElement>('button');
    if (!(viewport && control)) {
      throw new Error('Expected actual history viewport and control');
    }
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    viewport.scrollTop = 180;
    control.focus();
    expect(document.activeElement).toBe(control);
    failRead(fixture, 'network');
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() =>
      expect(fixture.container.querySelector('[role="status"] p')?.textContent).toBe(staleNotice)
    );
    expect(fixture.container.querySelector('[data-radix-scroll-area-viewport]')).toBe(viewport);
    expect(fixture.container.querySelector('[data-radix-scroll-area-viewport] button')).toBe(
      control
    );
    expect(document.activeElement).toBe(control);
    expect(viewport.scrollTop).toBe(180);
    fixture.response.error = undefined;
    fixture.response.wire = JSON.stringify({ messages: [user('valid recovery')] });
    await fixture.queryClient.refetchQueries();
    await vi.waitFor(() => expect(fixture.container.textContent).toContain('valid recovery'));
    await vi.waitFor(() => expect(viewport.scrollTop).toBe(1000));
  });
});
