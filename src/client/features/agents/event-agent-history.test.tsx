// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StoryTrpcProvider } from '@/client/lib/storybook-trpc';
import { waitForCheck } from '@/test-utils/react-act';
import { EventAgentHistory } from './event-agent-history';
import { eventAgentFixture } from './event-agent.test-support';
import { eventEvaluationFixture, eventRunFixture } from './event-history.story-fixtures';

let container: HTMLDivElement;
let root: Root;
let requests: { path: string; input: unknown }[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  requests = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows the saved automation runs and, on request, its events', async () => {
  act(() =>
    root.render(
      <MemoryRouter>
        <StoryTrpcProvider
          onRequest={(path, input) => requests.push({ path, input })}
          handlers={{
            'automation.runs': () => ({ items: [eventRunFixture()], nextCursor: null }),
            'automation.evaluations': () => ({
              items: [eventEvaluationFixture()],
              nextCursor: null,
            }),
          }}
        >
          <EventAgentHistory
            agent={eventAgentFixture()}
            projectSlug="owner-slug"
            archived={false}
          />
        </StoryTrpcProvider>
      </MemoryRouter>
    )
  );
  await waitForCheck(() =>
    expect(container.querySelector('[data-run-id="run-pr"]')).not.toBeNull()
  );
  expect(
    container.querySelector(
      '[data-run-id="run-pr"] a[href="/projects/owner-slug/workspaces/workspace-pr"]'
    )?.textContent
  ).toContain('Open workspace');
  expect(requests.find((item) => item.path === 'automation.runs')?.input).toEqual({
    projectId: 'owner',
    agentId: 'event-agent',
    direction: 'forward',
  });
  // Events load only once their view is opened.
  expect(requests.some((item) => item.path === 'automation.evaluations')).toBe(false);

  const events = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => tab.textContent === 'Events'
  );
  await act(async () => events?.click());
  await waitForCheck(() =>
    expect(container.querySelector('[data-evaluation-id="evaluation-matched"]')).not.toBeNull()
  );
  // The trigger is named from the saved definition, not only by its ID.
  expect(container.querySelector('[data-evaluation-id]')?.textContent).toContain(
    'Investigate labeled issues'
  );
});
