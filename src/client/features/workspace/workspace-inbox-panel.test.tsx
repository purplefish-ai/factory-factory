// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { WorkspaceInboxPanel } from './workspace-inbox-panel';

const summary = {
  id: 'mail-1',
  revision: 3,
  subject: 'Review ready',
  preview: 'The review is ready.',
  kind: 'COMPLETION',
  sourceWorkspaceId: 'sender',
  sourceWorkspaceName: 'Reviewer',
  sourceProjectName: 'Demo',
  createdAt: new Date('2026-11-02T12:00:00Z'),
  readAt: null,
  acknowledgedAt: null,
  supersededAt: null,
  taskKey: null,
  taskRevision: null,
};

describe('WorkspaceInboxPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let render: () => void;
  let requests: { path: string; input: unknown }[];
  let respond: (path: string, input: unknown) => unknown;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    requests = [];
    respond = (path) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null };
      }
      if (path === 'workspace.readMail') {
        return {
          items: [{ ...summary, body: 'Full report body', offset: 0, nextOffset: null }],
          revision: 3,
        };
      }
      return { acknowledged: 1, revision: 3 };
    };
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const api = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              requests.push({ path: op.path, input: op.input });
              Promise.resolve()
                .then(() => respond(op.path, op.input))
                .then(
                  (data) => {
                    observer.next({ result: { data } });
                    observer.complete();
                  },
                  (error: Error) => observer.error(new TRPCClientError(error.message))
                );
            }),
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render = () =>
      act(() =>
        root.render(
          <trpc.Provider client={api} queryClient={client}>
            <QueryClientProvider client={client}>
              <WorkspaceInboxPanel workspaceId="recipient" />
            </QueryClientProvider>
          </trpc.Provider>
        )
      );
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  async function waitForText(text: string) {
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain(text));
    });
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(label)
    );
    expect(button, `missing ${label}`).toBeDefined();
    await act(() => {
      button?.click();
    });
  }
  it('lists bounded summaries without reading or acknowledging bodies', async () => {
    render();
    await waitForText('Review ready');
    expect(container.textContent).toContain('1 unread');
    expect(container.textContent).toContain('Reviewer');
    expect(container.textContent).toContain('Completion');
    expect(container.textContent).not.toContain('Full report body');
    expect(container.textContent).not.toContain('Retry mail notification');
    expect(requests).toEqual([
      {
        path: 'workspace.listMail',
        input: { workspaceId: 'recipient', limit: 20, direction: 'forward' },
      },
    ]);
  });
  it('offers explicit notification recovery with pending, failure, and summary refresh states', async () => {
    let ambiguous = true;
    let fail = true;
    let finishRetry: () => void = () => {
      throw new Error('Retry has not started');
    };
    respond = (path) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null, wakeAmbiguous: ambiguous };
      }
      if (fail) {
        throw new Error('Offline');
      }
      return new Promise<{ retried: boolean }>((resolve) => {
        finishRetry = () => {
          resolve({ retried: true });
        };
      });
    };
    render();
    await waitForText('Delivery could not be confirmed. Retrying may notify the agent again.');
    expect(requests.some((item) => item.path === 'workspace.retryMailWake')).toBe(false);
    await click('Retry mail notification');
    await waitForText('Could not retry mail notification');
    fail = false;
    await click('Retry mail notification');
    await waitForText('Retrying notification');
    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retrying notification')
    );
    expect(retry?.disabled).toBe(true);
    await act(() => {
      ambiguous = false;
      finishRetry();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).not.toContain('Delivery could not be confirmed')
      );
    });
    expect(requests.filter((item) => item.path === 'workspace.retryMailWake')).toEqual([
      { path: 'workspace.retryMailWake', input: { workspaceId: 'recipient' } },
      { path: 'workspace.retryMailWake', input: { workspaceId: 'recipient' } },
    ]);
    expect(
      requests.some(
        (item) => item.path === 'workspace.ackMail' || item.path === 'workspace.readMail'
      )
    ).toBe(false);
    expect(requests.filter((item) => item.path === 'workspace.listMail')).toHaveLength(2);
  });
  it('reads only the selected message and acknowledges explicitly at the observed revision', async () => {
    render();
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('Full report body');
    expect(requests.filter((item) => item.path === 'workspace.readMail')).toEqual([
      {
        path: 'workspace.readMail',
        input: { workspaceId: 'recipient', ids: ['mail-1'], offset: 0, maxChars: 8192 },
      },
    ]);
    expect(requests.some((item) => item.path === 'workspace.ackMail')).toBe(false);
    await click('Acknowledge');
    await waitForText('Acknowledged');
    expect(requests.filter((item) => item.path === 'workspace.ackMail')).toEqual([
      {
        path: 'workspace.ackMail',
        input: { workspaceId: 'recipient', ids: ['mail-1'], throughRevision: 3 },
      },
    ]);
  });
  it('does not claim acknowledgement when the server did not acknowledge the selected mail', async () => {
    respond = (path) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null };
      }
      if (path === 'workspace.readMail') {
        return {
          items: [{ ...summary, body: 'Full report body', offset: 0, nextOffset: null }],
          revision: 3,
        };
      }
      return { acknowledged: 0, revision: 4 };
    };
    render();
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('Full report body');
    await click('Acknowledge');
    await waitForText('Could not acknowledge message');
    expect(container.textContent).not.toContain('Acknowledged');
  });
  it('retrieves continuation only on request and appends it to the report', async () => {
    respond = (path, input) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null };
      }
      const continuation =
        typeof input === 'object' && input !== null && 'offset' in input && input.offset === 5;
      return {
        items: [
          {
            ...summary,
            body: continuation ? 'second' : 'first',
            offset: continuation ? 5 : 0,
            nextOffset: continuation ? null : 5,
          },
        ],
        revision: 3,
      };
    };
    render();
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('first');
    expect(requests.filter((item) => item.path === 'workspace.readMail')).toHaveLength(1);
    await click('Read more');
    await waitForText('firstsecond');
    expect(requests.filter((item) => item.path === 'workspace.readMail')[1]?.input).toEqual({
      workspaceId: 'recipient',
      ids: ['mail-1'],
      offset: 5,
      maxChars: 8192,
    });
  });
  it('loads older summaries only after asking for the next page', async () => {
    respond = (path, input) => {
      if (path !== 'workspace.listMail') {
        return {};
      }
      const next =
        typeof input === 'object' &&
        input !== null &&
        'cursor' in input &&
        input.cursor !== undefined;
      return {
        items: next
          ? [{ ...summary, id: 'mail-older', subject: 'Older question', revision: 1 }]
          : [summary],
        revision: 3,
        nextCursor: next ? null : 3,
      };
    };
    render();
    await waitForText('Review ready');
    expect(container.textContent).not.toContain('Older question');
    await click('Load older messages');
    await waitForText('Older question');
    expect(container.textContent).toContain('Review ready');
    expect(requests[1]?.input).toEqual({
      workspaceId: 'recipient',
      cursor: 3,
      limit: 20,
      direction: 'forward',
    });
  });
  it('shows read errors with a retry without acknowledging the message', async () => {
    let fail = true;
    respond = (path) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null };
      }
      if (fail) {
        throw new Error('Offline');
      }
      return {
        items: [{ ...summary, body: 'Recovered report', offset: 0, nextOffset: null }],
        revision: 3,
      };
    };
    render();
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('Could not read message');
    expect(container.querySelector<HTMLButtonElement>('[data-mail-ack]')?.disabled).toBe(true);
    fail = false;
    await click('Try again');
    await waitForText('Recovered report');
    expect(requests.some((item) => item.path === 'workspace.ackMail')).toBe(false);
  });
  it('shows initial loading, an empty inbox, and a recoverable list failure', async () => {
    respond = () => {
      throw new Error('Offline');
    };
    render();
    expect(container.textContent).toContain('Loading inbox');
    await waitForText('Could not load inbox');
    respond = () => ({ items: [], revision: 0, nextCursor: null });
    await click('Try again');
    await waitForText('No messages yet');
  });
});
