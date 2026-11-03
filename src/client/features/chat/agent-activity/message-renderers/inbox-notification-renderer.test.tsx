// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { InboxNotificationRenderer } from './inbox-notification-renderer';

it('loads the recipient inbox only on expansion, then reads and acknowledges selected mail explicitly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: { path: string; input: unknown }[] = [];
  const summary = {
    id: 'mail-1',
    revision: 229,
    subject: 'Review ready',
    preview: 'The review is ready.',
    kind: 'COMPLETION',
    sourceWorkspaceId: 'sender',
    sourceWorkspaceName: 'Reviewer',
    sourceProjectName: 'Demo',
    createdAt: new Date('2026-11-03T12:00:00Z'),
    readAt: null,
    acknowledgedAt: null,
    supersededAt: null,
    taskKey: null,
    taskRevision: null,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            const data =
              op.path === 'workspace.listMail'
                ? { items: [summary], revision: 229, nextCursor: null }
                : op.path === 'workspace.readMail'
                  ? {
                      items: [
                        { ...summary, body: 'Full review report', offset: 0, nextOffset: null },
                      ],
                      revision: 229,
                    }
                  : { acknowledged: 1, revision: 229 };
            observer.next({ result: { data } });
            observer.complete();
          }),
    ],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  async function waitForText(text: string) {
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain(text));
    });
  }
  async function clickButton(text: string) {
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(text)
    );
    expect(button).toBeDefined();
    await act(() => button?.click());
  }
  try {
    await act(() =>
      root.render(
        <trpc.Provider client={api} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <InboxNotificationRenderer
              notification={{ kind: 'mail', workspaceId: 'recipient', revision: '228' }}
            />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    expect(requests).toEqual([]);
    expect(container.querySelector('details')?.open).toBe(false);
    await act(() => container.querySelector('summary')?.click());
    await waitForText('Review ready');
    expect(requests).toEqual([
      {
        path: 'workspace.listMail',
        input: { workspaceId: 'recipient', limit: 20, direction: 'forward' },
      },
    ]);
    expect(container.textContent).not.toContain('Full review report');
    await clickButton('Review ready');
    await waitForText('Full review report');
    expect(requests.filter((item) => item.path === 'workspace.readMail')).toEqual([
      {
        path: 'workspace.readMail',
        input: { workspaceId: 'recipient', ids: ['mail-1'], offset: 0, maxChars: 8192 },
      },
    ]);
    expect(requests.some((item) => item.path === 'workspace.ackMail')).toBe(false);
    await clickButton('Acknowledge');
    await waitForText('Acknowledged');
    expect(requests.filter((item) => item.path === 'workspace.ackMail')).toEqual([
      {
        path: 'workspace.ackMail',
        input: { workspaceId: 'recipient', ids: ['mail-1'], throughRevision: 229 },
      },
    ]);
    await act(() => container.querySelector('summary')?.click());
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('section')).toBeNull());
    });
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  }
});
