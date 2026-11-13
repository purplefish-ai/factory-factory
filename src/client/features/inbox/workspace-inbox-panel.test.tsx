// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { useWorkspaceUnreadCounts } from './use-workspace-unread-counts';
import { WorkspaceInboxPanel } from './workspace-inbox-panel';
import inboxStory from './workspace-inbox-panel.stories';

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

function TestUnreadCount() {
  const counts = useWorkspaceUnreadCounts('mail-project');
  return <span data-testid="unread-count">{counts.data?.recipient ?? 'loading'}</span>;
}

describe('WorkspaceInboxPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let render: () => void;
  let requests: { path: string; input: unknown }[];
  let respond: (path: string, input: unknown) => unknown;
  let showUnreadCount: boolean;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    requests = [];
    showUnreadCount = false;
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
              {showUnreadCount && <TestUnreadCount />}
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
  it('updates the shared badge after an explicit read without acknowledging or reading on list open', async () => {
    showUnreadCount = true;
    let unread = 1;
    const original = respond;
    respond = (path, input) => {
      if (path === 'workspace.unreadMailCounts') {
        return { recipient: unread };
      }
      if (path === 'workspace.readMail') {
        unread = 0;
      }
      return original(path, input);
    };
    await renderCountBeforeList();
    expect(
      requests.filter(
        (request) => request.path === 'workspace.readMail' || request.path === 'workspace.ackMail'
      )
    ).toHaveLength(0);
    await click('Review ready');
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="unread-count"]')?.textContent).toBe('0')
      );
    });
    expect(requests.filter((request) => request.path === 'workspace.ackMail')).toHaveLength(0);
  });

  it('refreshes shared counts when a pending read finishes after leaving its detail view', async () => {
    showUnreadCount = true;
    let unread = 1;
    let complete: () => void = () => undefined;
    const original = respond;
    respond = (path, input) => {
      if (path === 'workspace.unreadMailCounts') {
        return { recipient: unread };
      }
      if (path === 'workspace.readMail') {
        return new Promise((resolve) => {
          complete = () => {
            unread = 0;
            resolve(original(path, input));
          };
        });
      }
      return original(path, input);
    };
    await renderCountBeforeList();
    await click('Review ready');
    await click('Inbox');
    await act(() => complete());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="unread-count"]')?.textContent).toBe('0')
      );
    });
    expect(requests.filter((request) => request.path === 'workspace.ackMail')).toHaveLength(0);
  });

  // The unread count and the mail list are independent queries, and each
  // result renders in its own task, so either can appear first. Hold the list
  // until the count has rendered, then wait for the list before opening mail.
  async function renderCountBeforeList() {
    let releaseList: () => void = () => undefined;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const next = respond;
    respond = (path, input) =>
      path === 'workspace.listMail'
        ? listReleased.then(() => next(path, input))
        : next(path, input);
    await render();
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="unread-count"]')?.textContent).toBe('1')
      );
    });
    expect(container.textContent).toContain('Loading inbox');
    releaseList();
    await waitForText('Review ready');
  }
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
    const message = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Review ready')
    );
    expect(message?.querySelector('div, p')).toBeNull();
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
    await waitForText("Couldn't retry mail notification");
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
    await waitForText("Couldn't acknowledge message");
    expect(container.textContent).not.toContain('Acknowledged');
  });
  it('confirms an idempotent acknowledgement using the exact selected message', async () => {
    let acknowledged = false;
    respond = (path) => {
      if (path === 'workspace.listMail') {
        return { items: [summary], revision: 3, nextCursor: null };
      }
      if (path === 'workspace.readMail') {
        return {
          items: [
            {
              ...summary,
              acknowledgedAt: acknowledged ? new Date() : null,
              body: 'Report',
              offset: 0,
              nextOffset: null,
            },
          ],
          revision: 3,
        };
      }
      acknowledged = true;
      return { acknowledged: 0, revision: 3 };
    };
    render();
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('Report');
    await click('Acknowledge');
    await waitForText('Acknowledged');
    expect(container.querySelector<HTMLButtonElement>('[data-mail-ack]')?.disabled).toBe(true);
    expect(requests.filter((item) => item.path === 'workspace.readMail')).toHaveLength(2);
    expect(requests.filter((item) => item.path === 'workspace.readMail')[1]?.input).toMatchObject({
      workspaceId: 'recipient',
      ids: ['mail-1'],
    });
  });
  it.each(['missing', 'different'] as const)(
    'does not confirm zero-count acknowledgement from %s message evidence',
    async (evidence) => {
      let reads = 0;
      const firstRead = { ...summary, body: 'Report', offset: 0, nextOffset: null };
      const recheckItems =
        evidence === 'missing'
          ? []
          : [{ ...firstRead, id: 'other-mail', acknowledgedAt: new Date() }];
      respond = (path) => {
        if (path === 'workspace.listMail') {
          return { items: [summary], revision: 3, nextCursor: null };
        }
        if (path === 'workspace.readMail') {
          reads++;
          return {
            items: reads > 1 ? recheckItems : [firstRead],
            revision: 3,
          };
        }
        return { acknowledged: 0, revision: 3 };
      };
      render();
      await waitForText('Review ready');
      await click('Review ready');
      await waitForText('Report');
      await click('Acknowledge');
      await waitForText("Couldn't acknowledge message");
      expect(reads).toBe(2);
      expect(container.textContent).not.toContain('Acknowledged');
    }
  );
  it.each(['acknowledged', 'superseded'] as const)(
    'does not style %s mail as unread',
    async (state) => {
      respond = () => ({
        items: [
          {
            ...summary,
            acknowledgedAt: state === 'acknowledged' ? new Date() : null,
            supersededAt: state === 'superseded' ? new Date() : null,
          },
        ],
        revision: 3,
        nextCursor: null,
      });
      render();
      await waitForText('Review ready');
      expect(container.textContent).toContain('0 unread');
      const title = [...container.querySelectorAll('span')].find(
        (item) => item.textContent === 'Review ready'
      );
      expect(title?.classList.contains('font-semibold')).toBe(false);
    }
  );
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
    expect(container.querySelector<HTMLButtonElement>('[data-mail-ack]')?.disabled).toBe(true);
    await click('Acknowledge');
    expect(requests.some((item) => item.path === 'workspace.ackMail')).toBe(false);
    await click('Read more');
    await waitForText('firstsecond');
    expect(container.querySelector<HTMLButtonElement>('[data-mail-ack]')?.disabled).toBe(false);
    expect(requests.filter((item) => item.path === 'workspace.readMail')[1]?.input).toEqual({
      workspaceId: 'recipient',
      ids: ['mail-1'],
      offset: 5,
      maxChars: 8192,
    });
  });
  it('shows the long-report story in bounded contiguous chunks', async () => {
    const InboxStory = inboxStory.component;
    act(() => root.render(<InboxStory scenario="long-report" />));
    await waitForText('Review ready');
    await click('Review ready');
    await waitForText('The first section covers');
    const first = container.querySelector('.whitespace-pre-wrap')?.textContent ?? '';
    expect(first.length).toBe(8192);
    expect(container.textContent).not.toContain('The remaining checks passed.');
    await click('Read more');
    await waitForText('The remaining checks passed.');
    const full = container.querySelector('.whitespace-pre-wrap')?.textContent ?? '';
    expect(full.startsWith(first)).toBe(true);
    expect(full.match(/All workspace permission checks passed\. /g)).toHaveLength(230);
    expect(full.endsWith('The remaining checks passed. The review is complete.')).toBe(true);
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
  it('keeps loaded summaries and retries the failed older page', async () => {
    let olderFails = true;
    respond = (path, input) => {
      if (path !== 'workspace.listMail') {
        return {};
      }
      const next =
        typeof input === 'object' &&
        input !== null &&
        'cursor' in input &&
        input.cursor !== undefined;
      if (next && olderFails) {
        throw new Error('Offline');
      }
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
    await click('Load older messages');
    await waitForText("Couldn't refresh");
    expect(container.textContent).toContain('Review ready');
    olderFails = false;
    const listRequests = requests.filter((item) => item.path === 'workspace.listMail').length;
    await click('Retry');
    await waitForText('Older question');
    // Retry fetched only the older page, not the already-loaded first page again.
    const retried = requests
      .filter((item) => item.path === 'workspace.listMail')
      .slice(listRequests);
    expect(retried.map((item) => item.input)).toEqual([
      { workspaceId: 'recipient', cursor: 3, limit: 20, direction: 'forward' },
    ]);
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
    await waitForText("Couldn't read message");
    expect(container.querySelector<HTMLButtonElement>('[data-mail-ack]')?.disabled).toBe(true);
    fail = false;
    await click('Retry');
    await waitForText('Recovered report');
    expect(requests.some((item) => item.path === 'workspace.ackMail')).toBe(false);
  });
  it('shows initial loading, an empty inbox, and a recoverable list failure', async () => {
    respond = () => {
      throw new Error('Offline');
    };
    render();
    expect(container.textContent).toContain('Loading inbox');
    await waitForText("Couldn't load inbox");
    respond = () => ({ items: [], revision: 0, nextCursor: null });
    await click('Retry');
    await waitForText('No messages yet');
  });
});
