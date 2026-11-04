// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { StoryTrpcProvider } from '@/client/lib/storybook-trpc';
import { waitForReact } from '@/test-utils/react-act';
import { renderEventCreationCancel } from './agent-menu.test-support';
import { AgentsPage } from './agents-page';
import { eventAgentFixture, eventSummaryFixture } from './event-agent.test-support';

const event = eventAgentFixture();
const scheduled = {
  id: 'scheduled',
  projectId: 'owner',
  name: 'Scheduled review',
  prompt: 'Review changes',
  cadence: 'DAILY',
  isEnabled: true,
  scheduledTime: null,
  timezone: null,
  scheduledDayOfMonth: null,
  nextRunAt: new Date('2026-11-04'),
  lastRunAt: null,
  createdAt: new Date('2026-11-04'),
  updatedAt: new Date('2026-11-04'),
  executions: [],
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root;
let scheduledWait: Promise<void> | undefined;
let eventWait: Promise<void> | undefined;
let detailWait: Promise<void> | undefined;
let eventEmpty: boolean;
let eventError: boolean;
function Page() {
  const { slug = 'owner' } = useParams();
  const location = useLocation();
  return (
    <>
      <Link to="/projects/other/agents?kind=event">Switch event project</Link>
      <AgentsPage
        project={{ id: slug, slug, name: slug }}
        renderEventCreation={renderEventCreationCancel}
      />
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
async function render(search = '?kind=event') {
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/projects/owner/agents${search}`]}>
        <StoryTrpcProvider
          handlers={{
            'periodicTask.list': async () => {
              await scheduledWait;
              return [scheduled];
            },
            'agent.list': async () => {
              await eventWait;
              if (eventError) {
                throw new Error('Event list unavailable');
              }
              return { items: eventEmpty ? [] : [eventSummaryFixture(event)], nextCursor: null };
            },
            'periodicTask.get': () => scheduled,
            'periodicTask.listExecutions': () => [],
            'agent.get': async (input) => {
              await detailWait;
              return {
                ...event,
                projectId: z.object({ projectId: z.string() }).parse(input).projectId,
              };
            },
          }}
        >
          <Routes>
            <Route path="/projects/:slug/agents/:id?" element={<Page />} />
          </Routes>
        </StoryTrpcProvider>
      </MemoryRouter>
    )
  );
}
const currentPath = () => container.querySelector('output')?.textContent;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  scheduledWait = undefined;
  eventWait = undefined;
  detailWait = undefined;
  eventEmpty = false;
  eventError = false;
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it.each(['scheduled', 'event'] as const)(
  'retains an event index when %s resolves first',
  async (first) => {
    const scheduledRequest = deferred();
    const eventRequest = deferred();
    scheduledWait = scheduledRequest.promise;
    eventWait = eventRequest.promise;
    await render();
    await act(() => (first === 'scheduled' ? scheduledRequest : eventRequest).resolve());
    expect(currentPath()).not.toContain('/scheduled');
    await act(() => (first === 'scheduled' ? eventRequest : scheduledRequest).resolve());
    await waitForReact(() =>
      expect(currentPath()).toBe(`/projects/owner/agents/${event.id}?kind=event`)
    );
    expect(container.querySelector('nav [aria-current]')?.getAttribute('href')).toContain(
      '?kind=event'
    );
  }
);
it.each(['empty', 'error'] as const)(
  'keeps an explicit event index for an %s event list',
  async (state) => {
    eventEmpty = state === 'empty';
    eventError = state === 'error';
    await render();
    await waitForReact(() =>
      expect(container.textContent).toContain(
        state === 'empty' ? 'Scheduled review' : 'Event list unavailable'
      )
    );
    expect(currentPath()).toBe('/projects/owner/agents?kind=event');
    expect(container.querySelector('nav [aria-current]')).toBeNull();
  }
);
it.each(['', '?kind=scheduled'])('keeps scheduled-first selection for index %s', async (search) => {
  await render(search);
  await waitForReact(() => expect(currentPath()).toBe('/projects/owner/agents/scheduled'));
});
it('keeps the event kind and destination owner after switching projects', async () => {
  await render();
  await waitForReact(() =>
    expect(currentPath()).toBe(`/projects/owner/agents/${event.id}?kind=event`)
  );
  await act(() =>
    container
      .querySelector<HTMLAnchorElement>('a[href="/projects/other/agents?kind=event"]')
      ?.click()
  );
  await waitForReact(() =>
    expect(currentPath()).toBe(`/projects/other/agents/${event.id}?kind=event`)
  );
  expect(container.querySelector('nav [aria-current]')?.getAttribute('href')).toBe(
    `/projects/other/agents/${event.id}?kind=event`
  );
});

it('keeps a loaded rail free of list-loading feedback while the selected event loads', async () => {
  const detail = deferred();
  detailWait = detail.promise;
  await render(`/${event.id}?kind=event`);
  await waitForReact(() =>
    expect(container.querySelector('nav')?.textContent).toContain('Scheduled review')
  );
  expect(container.querySelector('main')?.textContent).toContain('Loading event agent…');
  expect(container.querySelector('nav')?.textContent).not.toContain('Loading agents…');
  await act(() => detail.resolve());
});
