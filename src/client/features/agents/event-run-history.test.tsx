// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStoryTrpcClient } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import { waitForCheck } from '@/test-utils/react-act';
import { eventRunFixture, eventRunPageFixture } from './event-history.story-fixtures';
import { EventRunHistory } from './event-run-history';
import type { EventRun } from './types';

const historyInput = z.strictObject({
  projectId: z.string(),
  agentId: z.string(),
  cursor: z.string().optional(),
});

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let requests: z.infer<typeof historyInput>[];
let pages: Record<string, { items: EventRun[]; nextCursor: string | null }>;
let failure: string | null;

function render(renderRunActions?: (run: EventRun) => React.ReactNode) {
  const client = createStoryTrpcClient({
    handlers: {
      'automation.runs': (input) => {
        const parsed = historyInput.parse(input);
        requests.push(parsed);
        if (failure) {
          throw new Error(failure);
        }
        return pages[parsed.cursor ?? 'first'];
      },
    },
  });
  act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventRunHistory
              projectId="owner"
              agentId="event-agent"
              projectSlug="owner-slug"
              renderRunActions={renderRunActions}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}

function runArticle(runId: string) {
  const article = container.querySelector(`[data-run-id="${runId}"]`);
  if (!(article instanceof HTMLElement)) {
    throw new Error(`Missing run ${runId}`);
  }
  return article;
}

function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text
  );
  if (!found) {
    throw new Error(`Missing button ${text}`);
  }
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  failure = null;
  pages = { first: { items: eventRunPageFixture(), nextCursor: null } };
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('EventRunHistory', () => {
  it('shows each run with its status, a readable reason, its workspace and its PR links', async () => {
    pages.first?.items.push(
      eventRunFixture({
        id: 'run-reserved',
        status: 'FAILED',
        reasonCode: 'PROVISIONING_FAILED',
        result: null,
        workspaceId: null,
        workspaceState: 'RESERVED',
      })
    );
    render();
    await waitForCheck(() => expect(container.querySelector('[data-run-id]')).not.toBeNull());

    const finished = runArticle('run-pr');
    expect(finished.textContent).toContain('PR created');
    const workspace = finished.querySelector(
      'a[href="/projects/owner-slug/workspaces/workspace-pr"]'
    );
    expect(workspace?.textContent).toContain('Open workspace');
    const pr = finished.querySelector('a[href="https://github.com/example/repo/pull/42"]');
    expect(pr?.textContent).toContain('PR #42');
    expect(pr?.getAttribute('target')).toBe('_blank');

    const attention = runArticle('run-attention');
    expect(attention.textContent).toContain('Needs attention');
    expect(attention.textContent).toContain('The first message may have reached the agent');
    // The reason code stays available for support, behind its readable phrase.
    expect(attention.querySelector('[title="DELIVERY_UNCERTAIN"]')).not.toBeNull();
    expect(attention.querySelector('details')?.textContent).toContain('DELIVERY_UNCERTAIN');

    const queued = runArticle('run-queued');
    expect(queued.textContent).toContain('Queued');
    expect(queued.textContent).toContain('Waiting for a free run slot');
    expect(queued.textContent).toContain('No workspace yet');

    const overflow = runArticle('run-overflow');
    expect(overflow.textContent).toContain('Cancelled');
    expect(overflow.textContent).toContain('Too many runs were already waiting');
    expect(overflow.textContent).toContain('No workspace was created');

    const timedOut = runArticle('run-setup-timeout');
    expect(timedOut.textContent).toContain('Failed');
    expect(timedOut.textContent).toContain('Workspace setup took too long');
    expect(timedOut.textContent).toContain('Workspace deleted');
    expect(timedOut.textContent).toContain('Run details expired');

    const completed = runArticle('run-completed');
    expect(completed.textContent).toContain('Completed');
    expect(completed.querySelector('a[href$="/workspaces/workspace-completed"]')).not.toBeNull();

    expect(runArticle('run-reserved').textContent).toContain('Workspace unavailable');
    expect(runArticle('run-reserved').querySelector('a')).toBeNull();
    // Missing results are never presented as an empty or finished outcome.
    expect(container.textContent).not.toMatch(/no result|empty result/i);
  });

  it('explains runs that ended before their child workspaces had finished', async () => {
    pages.first?.items.push(
      eventRunFixture({
        id: 'run-child-hold',
        status: 'COMPLETED',
        reasonCode: 'CHILD_HOLD_EXPIRED',
      }),
      eventRunFixture({
        id: 'run-child-abandoned',
        status: 'PR_CREATED',
        reasonCode: 'ABANDONED_WITH_CHILD_WORK',
      })
    );
    render();
    await waitForCheck(() => expect(container.querySelector('[data-run-id]')).not.toBeNull());

    const expired = runArticle('run-child-hold');
    expect(expired.textContent).toContain("Child workspaces hadn't finished after 24 hours");
    expect(expired.textContent).not.toContain('Unrecognized reason');
    const abandoned = runArticle('run-child-abandoned');
    expect(abandoned.textContent).toContain(
      'Abandoned by a person before its child workspaces had finished'
    );
    expect(abandoned.textContent).not.toContain('Unrecognized reason');
  });

  it('requests the next cursor when loading more and appends that page', async () => {
    const [first, second, ...rest] = eventRunPageFixture();
    pages = {
      first: { items: [first!, second!], nextCursor: 'runs-page-2' },
      'runs-page-2': { items: rest, nextCursor: null },
    };
    render();
    await waitForCheck(() => expect(button('Load more runs')).toBeDefined());
    expect(container.querySelector('[data-run-id="run-pr"]')).toBeNull();

    await act(async () => button('Load more runs').click());
    await waitForCheck(() => expect(runArticle('run-pr')).toBeDefined());
    expect(requests.at(-1)).toEqual({
      projectId: 'owner',
      agentId: 'event-agent',
      cursor: 'runs-page-2',
    });
    expect(runArticle('run-queued')).toBeDefined();
    expect(container.textContent).not.toContain('Load more runs');
  });

  it('keeps cached runs with a retry notice when a refresh fails', async () => {
    render();
    await waitForCheck(() => expect(runArticle('run-pr')).toBeDefined());

    failure = 'Database is locked';
    await act(async () => {
      await queryClient.refetchQueries().catch(() => undefined);
    });
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't refresh runs"));
    expect(container.textContent).toContain('Database is locked');
    expect(runArticle('run-pr')).toBeDefined();

    failure = null;
    await act(async () => button('Retry').click());
    await waitForCheck(() => expect(container.textContent).not.toContain("Couldn't refresh runs"));
    expect(runArticle('run-pr')).toBeDefined();
  });

  it('shows a load error without claiming the automation has no runs', async () => {
    failure = 'Database is locked';
    render();
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't load runs"));
    expect(container.textContent).not.toContain('No runs yet');
  });

  it('shows an empty state once a successful read has no runs, and keeps it under a failed refresh', async () => {
    pages.first = { items: [], nextCursor: null };
    render();
    await waitForCheck(() => expect(container.textContent).toContain('No runs yet'));

    failure = 'Database is locked';
    await act(async () => {
      await queryClient.refetchQueries().catch(() => undefined);
    });
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't refresh runs"));
    expect(container.textContent).toContain('No runs yet');
  });

  it('renders the run action slot for each run', async () => {
    render((run) => <button type="button">Inspect {run.id}</button>);
    await waitForCheck(() => expect(button('Inspect run-attention')).toBeDefined());
    expect(button('Inspect run-pr')).toBeDefined();
  });
});
