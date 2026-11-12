// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStoryTrpcClient } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import { waitForCheck } from '@/test-utils/react-act';
import { EventEvaluationHistory } from './event-evaluation-history';
import { eventEvaluationFixture, eventEvaluationPageFixture } from './event-history.story-fixtures';
import type { EventEvaluation } from './types';

const historyInput = z.strictObject({
  projectId: z.string(),
  agentId: z.string(),
  cursor: z.string().optional(),
});

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let requests: z.infer<typeof historyInput>[];
let pages: Record<string, { items: EventEvaluation[]; nextCursor: string | null }>;
let failure: string | null;

function render() {
  const client = createStoryTrpcClient({
    handlers: {
      'automation.evaluations': (input) => {
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
          <EventEvaluationHistory
            projectId="owner"
            agentId="event-agent"
            triggerLabels={{ 'saved-event:github': 'Investigate labeled issues' }}
          />
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}

function evaluation(id: string) {
  const article = container.querySelector(`[data-evaluation-id="${id}"]`);
  if (!(article instanceof HTMLElement)) {
    throw new Error(`Missing evaluation ${id}`);
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
  pages = { first: { items: eventEvaluationPageFixture(), nextCursor: null } };
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('EventEvaluationHistory', () => {
  it('shows why matched, skipped and errored events were decided', async () => {
    pages.first?.items.push(
      eventEvaluationFixture({ id: 'evaluation-removed-trigger', triggerId: 'unlisted-trigger' })
    );
    render();
    await waitForCheck(() => expect(evaluation('evaluation-matched')).toBeDefined());

    const matched = evaluation('evaluation-matched');
    expect(matched.textContent).toContain('Matched');
    expect(matched.textContent).toContain('The event matched this trigger');
    expect(matched.textContent).toContain('Started a run');
    expect(matched.textContent).toContain('Trigger: Investigate labeled issues');

    const skipped = evaluation('evaluation-skipped');
    expect(skipped.textContent).toContain('Skipped');
    expect(skipped.textContent).toContain("The event's label doesn't match this trigger");
    expect(skipped.querySelector('[title="LABEL_MISMATCH"]')).not.toBeNull();
    expect(skipped.textContent).not.toContain('Started a run');

    const errored = evaluation('evaluation-error');
    expect(errored.textContent).toContain('Error');
    expect(errored.textContent).toContain("Couldn't read the automation's execution settings");
    expect(errored.textContent).toContain('Next attempt');
    expect(errored.querySelector('details')?.textContent).toContain('EXECUTION_RESOLUTION_RETRY');

    // The API's fixed placeholder explanation adds nothing to the reason.
    expect(container.textContent).not.toContain('Recorded event evaluation.');
    // A trigger outside the loaded definition pages is still identified.
    expect(evaluation('evaluation-removed-trigger').textContent).toContain(
      'Trigger: unlisted-trigger'
    );
  });

  it('requests the next cursor when loading more events', async () => {
    const [first, ...rest] = eventEvaluationPageFixture();
    pages = {
      first: { items: [first!], nextCursor: 'events-page-2' },
      'events-page-2': { items: rest, nextCursor: null },
    };
    render();
    await waitForCheck(() => expect(button('Load more events')).toBeDefined());
    await act(async () => button('Load more events').click());
    await waitForCheck(() => expect(evaluation('evaluation-matched')).toBeDefined());
    expect(requests.at(-1)).toEqual({
      projectId: 'owner',
      agentId: 'event-agent',
      cursor: 'events-page-2',
    });
  });

  it('keeps cached events with a retry notice when a refresh fails', async () => {
    render();
    await waitForCheck(() => expect(evaluation('evaluation-matched')).toBeDefined());
    failure = 'Database is locked';
    await act(async () => {
      await queryClient.refetchQueries().catch(() => undefined);
    });
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't refresh events"));
    expect(evaluation('evaluation-matched')).toBeDefined();
  });

  it('shows a load error, and an empty state only after a successful empty read', async () => {
    failure = 'Database is locked';
    render();
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't load events"));
    expect(container.textContent).not.toContain('No events yet');

    failure = null;
    pages.first = { items: [], nextCursor: null };
    await act(async () => button('Retry').click());
    await waitForCheck(() => expect(container.textContent).toContain('No events yet'));
  });
});
