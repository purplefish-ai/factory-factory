// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import {
  agentActivationInputSchema,
  agentSourceResetInputSchema,
  managedAgentSchema,
} from '@/shared/agent-management';
import { waitForReact } from '@/test-utils/react-act';
import { renderEventCreationCancel } from './agent-menu.test-support';
import { AgentsPage } from './agents-page';
import { eventAgentFixture, eventSummaryFixture } from './event-agent.test-support';

type Saved = ReturnType<typeof eventAgentFixture>;
type Trigger = Saved['configuredTriggers'][number];
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let saved: Saved;
let archived: boolean;
let requests: Array<{ path: string; input: unknown }>;
let activationFailure: 'PRECONDITION_FAILED' | undefined;
let resetFailure: 'PRECONDITION_FAILED' | 'NOT_FOUND' | undefined;
const updatedAt = '2026-11-12T00:00:00.000Z';
const recoveryRequired = {
  state: 'RECOVERY_REQUIRED',
  reasonCode: 'GITHUB_CONTINUITY_LOST',
  updatedAt,
} as const;

function trpcError(code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'NOT_FOUND', message: string) {
  const statuses = { CONFLICT: 409, PRECONDITION_FAILED: 412, NOT_FOUND: 404 } as const;
  return new TRPCClientError(message, {
    result: { error: { message, code: -32_000, data: { code, httpStatus: statuses[code] } } },
  });
}
function withTriggers(map: (trigger: Trigger) => Trigger, overrides: Partial<Saved> = {}) {
  return managedAgentSchema.parse({
    ...saved,
    ...overrides,
    configuredTriggers: saved.configuredTriggers.map(map),
  });
}
/** What the server does: Enable starts supported triggers, Pause stops them; both bump the revision. */
function activate(input: unknown, enable: boolean) {
  const args = agentActivationInputSchema.parse(input);
  if (args.expectedManagementRevision !== saved.managementRevision) {
    throw trpcError('CONFLICT', 'This automation changed. Reload it and try again.');
  }
  if (enable && activationFailure) {
    throw trpcError(
      activationFailure,
      'No trigger in this automation can start. Slack event intake is not running in this app.'
    );
  }
  saved = withTriggers(
    (trigger) =>
      trigger.capability.status !== 'SUPPORTED'
        ? trigger
        : {
            ...trigger,
            isEnabled: enable,
            activationState: enable ? 'STARTING' : 'PAUSED',
            pausedReasonCode: null,
          },
    { isEnabled: enable, managementRevision: saved.managementRevision + 1 }
  );
  return saved;
}
function resetSource(input: unknown) {
  const args = agentSourceResetInputSchema.parse(input);
  if (resetFailure === 'NOT_FOUND') {
    throw trpcError('NOT_FOUND', 'This project does not use that source.');
  }
  if (resetFailure) {
    throw trpcError('PRECONDITION_FAILED', 'The source no longer needs a reset.');
  }
  saved = withTriggers(
    (trigger) => ({
      ...trigger,
      isEnabled: false,
      activationState: 'PAUSED',
      pausedReasonCode: null,
      sourceHealth: { state: 'DISCONNECTED', reasonCode: 'GITHUB_SOURCE_RESET', updatedAt },
    }),
    { managementRevision: saved.managementRevision + 1 }
  );
  return { connectionId: args.connectionId, pausedTriggerCount: 3, cancelledRunCount: 1 };
}
function respond(path: string, input: unknown) {
  switch (path) {
    case 'automation.enable':
    case 'automation.pause':
      return activate(input, path === 'automation.enable');
    case 'automation.resetSource':
      return resetSource(input);
    case 'automation.get':
      return saved;
    case 'automation.list':
      return { items: [eventSummaryFixture(saved)], nextCursor: null };
    case 'automation.runs':
    case 'automation.evaluations':
      return { items: [], nextCursor: null };
    case 'automation.navigationSummary':
    case 'periodicTask.navigationSummary':
      return { totalCount: 1, failedCount: 0 };
    case 'periodicTask.list':
      return [];
    default:
      throw new Error(`Unexpected ${path}`);
  }
}
function Harness() {
  const location = useLocation();
  return (
    <>
      <AgentsPage
        project={{ id: 'owner', slug: 'owner', name: 'Project', isArchived: archived }}
        renderEventCreation={renderEventCreationCancel}
      />
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
async function render() {
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            void Promise.resolve()
              .then(() => respond(op.path, op.input))
              .then(
                (data) => {
                  observer.next({ result: { data } });
                  observer.complete();
                },
                (error) => observer.error(TRPCClientError.from(error))
              );
          }),
    ],
  });
  await act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/projects/owner/agents/event-agent?kind=event']}>
            <Routes>
              <Route path="/projects/:slug/agents/:id?" element={<Harness />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
  await waitForReact(() =>
    expect(container.querySelector('main h2')?.textContent).toBe(saved.name)
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) {
    throw new Error(`Missing button ${text}`);
  }
  return found;
}
async function click(text: string) {
  await act(() => button(text).click());
}
function triggerCard(description: string) {
  const card = [...container.querySelectorAll('main article')].find(
    (item) => item.querySelector('h4')?.textContent === description
  );
  if (!card) {
    throw new Error(`Missing trigger ${description}`);
  }
  return card;
}
function dialog() {
  return document.querySelector('[role="alertdialog"]');
}
async function confirmDialog(text: string) {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === text
  );
  if (!found) {
    throw new Error(`Missing dialog button ${text}`);
  }
  await act(() => found.click());
}
/** Text outside every collapsed details section. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return '';
  }
  for (const details of copy.querySelectorAll('details')) {
    details.remove();
  }
  return copy.textContent ?? '';
}
function slackTrigger(github: Trigger): Trigger {
  return {
    ...github,
    id: 'saved-event:slack',
    configuration: {
      type: 'SLACK_MESSAGE',
      connectionId: 'slack-connection',
      description: 'Feedback channel messages',
      filterInstructions: null,
      isEnabled: false,
      config: {
        version: 1,
        channelIds: ['C1'],
        context: { includeThread: true, nearbyMessageCount: 0 },
      },
    },
    capability: {
      status: 'UNAVAILABLE',
      reasonCode: 'SLACK_INTAKE_UNAVAILABLE',
      explanation: 'Slack event intake is not running in this app.',
    },
    sourceName: '#feedback',
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved = eventAgentFixture();
  archived = false;
  requests = [];
  activationFailure = undefined;
  resetFailure = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

it("enables with the loaded revision and shows each trigger as Starting, Listening or Can't run", async () => {
  saved = managedAgentSchema.parse({
    ...saved,
    configuredTriggers: [...saved.configuredTriggers, slackTrigger(saved.configuredTriggers[0]!)],
  });
  await render();
  expect(triggerCard('Investigate labeled issues').textContent).toContain('Paused');
  const historyReads = requests.filter((item) => item.path === 'automation.runs').length;
  await click('Enable');
  await waitForReact(() =>
    expect(requests.find((item) => item.path === 'automation.enable')?.input).toEqual({
      projectId: 'owner',
      agentId: 'event-agent',
      expectedManagementRevision: 2,
    })
  );
  await waitForReact(() =>
    expect(triggerCard('Investigate labeled issues').textContent).toContain('Starting')
  );
  const slack = triggerCard('Feedback channel messages').textContent;
  expect(slack).toContain("Can't run");
  expect(slack).toContain('Slack event intake is not running in this app.');
  expect(button('Pause')).toBeDefined();
  await waitForReact(() =>
    expect(requests.filter((item) => item.path === 'automation.runs').length).toBeGreaterThan(
      historyReads
    )
  );
  // The poll-cycle job finishes the baseline; the next read shows Listening.
  saved = withTriggers((trigger) =>
    trigger.activationState === 'STARTING' ? { ...trigger, activationState: 'ACTIVE' } : trigger
  );
  await act(() => queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.automation.get) }));
  await waitForReact(() =>
    expect(triggerCard('Investigate labeled issues').textContent).toContain('Listening')
  );
  expect(container.querySelector('main header')?.textContent).toContain('Active');
});

it('lists the reasons inline when nothing can start', async () => {
  activationFailure = 'PRECONDITION_FAILED';
  await render();
  await click('Enable');
  await waitForReact(() =>
    expect(container.querySelector('main [role="alert"]')?.textContent).toContain(
      'Slack event intake is not running in this app.'
    )
  );
  expect(container.querySelector('main [role="alert"]')?.textContent).toContain(
    "Couldn't enable this automation."
  );
  expect(button('Enable').disabled).toBe(false);
});

it('prompts a reload on a conflict and keeps the page', async () => {
  await render();
  saved = { ...saved, managementRevision: 3 };
  await click('Enable');
  await waitForReact(() =>
    expect(container.querySelector('main')?.textContent).toContain(
      'This automation changed since it was loaded'
    )
  );
  expect(container.querySelector('main h2')?.textContent).toBe(saved.name);
  expect(container.querySelector('output')?.textContent).toBe(
    '/projects/owner/agents/event-agent?kind=event'
  );
  await click('Reload automation');
  await waitForReact(() =>
    expect(container.querySelector('main')?.textContent).not.toContain(
      'This automation changed since it was loaded'
    )
  );
  await click('Enable');
  await waitForReact(() =>
    expect(
      requests
        .filter((item) => item.path === 'automation.enable')
        .map((item) => agentActivationInputSchema.parse(item.input).expectedManagementRevision)
    ).toEqual([2, 3])
  );
});

it('pauses with the loaded revision and says that started work continues', async () => {
  saved = withTriggers((trigger) => ({ ...trigger, isEnabled: true, activationState: 'ACTIVE' }), {
    isEnabled: true,
  });
  await render();
  expect(triggerCard('Investigate labeled issues').textContent).toContain('Listening');
  expect(container.querySelector('main')?.textContent).toContain('Runs already started continue');
  await click('Pause');
  await waitForReact(() =>
    expect(requests.find((item) => item.path === 'automation.pause')?.input).toEqual({
      projectId: 'owner',
      agentId: 'event-agent',
      expectedManagementRevision: 2,
    })
  );
  await waitForReact(() =>
    expect(triggerCard('Investigate labeled issues').textContent).toContain('Paused')
  );
  expect(button('Enable')).toBeDefined();
});

it('resets a source that needs recovery only after a confirmation that names the gap', async () => {
  saved = withTriggers((trigger) => ({
    ...trigger,
    pausedReasonCode: 'SOURCE_RECOVERY_REQUIRED',
    sourceHealth: recoveryRequired,
  }));
  await render();
  const other = getQueryKey(
    trpc.automation.get,
    { projectId: 'owner', agentId: 'other-automation' },
    'query'
  );
  queryClient.setQueryData(other, saved);
  // The reset pauses automations on this source in other projects too.
  const otherProject = getQueryKey(
    trpc.automation.get,
    { projectId: 'elsewhere', agentId: 'shared-source' },
    'query'
  );
  queryClient.setQueryData(otherProject, saved);
  await click('Reset source');
  expect(requests.some((item) => item.path === 'automation.resetSource')).toBe(false);
  expect(dialog()?.textContent).toContain('Events from the gap will not run');
  expect(dialog()?.textContent).toContain('other projects');
  resetFailure = 'PRECONDITION_FAILED';
  await confirmDialog('Reset source');
  await waitForReact(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      'The source no longer needs a reset.'
    )
  );
  resetFailure = undefined;
  await confirmDialog('Reset source');
  await waitForReact(() => expect(dialog()).toBeNull());
  expect(requests.filter((item) => item.path === 'automation.resetSource').at(-1)?.input).toEqual({
    projectId: 'owner',
    connectionId: 'github-connection',
  });
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(otherProject)?.isInvalidated).toBe(true);
  await waitForReact(() =>
    expect(container.querySelector('main [role="status"]')?.textContent).toContain('Source reset')
  );
  await waitForReact(() =>
    expect(triggerCard('Investigate labeled issues').textContent).toContain(
      'Reset. Enable the automation to listen from now on.'
    )
  );
});

it('says a source the project no longer uses cannot be reset from here', async () => {
  saved = withTriggers((trigger) => ({ ...trigger, sourceHealth: recoveryRequired }));
  resetFailure = 'NOT_FOUND';
  await render();
  await click('Reset source');
  await confirmDialog('Reset source');
  await waitForReact(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      'This project no longer uses this source.'
    )
  );
});

it('disables Pause and Reset source in an archived project', async () => {
  archived = true;
  saved = withTriggers((trigger) => ({
    ...trigger,
    isEnabled: true,
    activationState: 'ACTIVE',
    sourceHealth: recoveryRequired,
  }));
  await render();
  expect(button('Pause').disabled).toBe(true);
  expect(button('Reset source').disabled).toBe(true);
});

it('disables Enable in an archived project', async () => {
  archived = true;
  await render();
  expect(button('Enable').disabled).toBe(true);
});

it('tells the user to reload when the source no longer needs a reset', async () => {
  saved = withTriggers((trigger) => ({ ...trigger, sourceHealth: recoveryRequired }));
  resetFailure = 'PRECONDITION_FAILED';
  await render();
  await click('Reset source');
  await confirmDialog('Reset source');
  await waitForReact(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Reload the automation to see the source's current state."
    )
  );
});

it('keeps revisions and raw JSON in collapsed details and never says listening is unavailable', async () => {
  await render();
  const main = container.querySelector('main')!;
  expect([...main.querySelectorAll('details')].every((details) => !details.open)).toBe(true);
  expect(main.textContent).toContain('Management revision 2');
  expect(visibleText(main)).not.toMatch(/revision/i);
  expect(visibleText(main)).not.toContain('"version"');
  expect(main.textContent).not.toMatch(/not (yet )?available/);
  await click('Edit automation');
  await waitForReact(() => expect(container.querySelector('form')).not.toBeNull());
  expect(visibleText(main)).not.toMatch(/revision \d/i);
  expect(main.textContent).toContain('Saved management revision 2');
  expect(main.textContent).not.toMatch(/not (yet )?available/);
});
