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
import { agentActivationInputSchema, managedAgentSchema } from '@/shared/agent-management';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { waitForReact } from '@/test-utils/react-act';
import { renderEventCreationCancel } from './agent-menu.test-support';
import { AgentsPage } from './agents-page';
import {
  eventAgentFixture,
  eventSummaryFixture,
  triggerInBackendState,
} from './event-agent.test-support';

type Saved = ReturnType<typeof eventAgentFixture>;
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let saved: Saved;
let deleted: boolean;
let archived: boolean;
let unfinishedRuns: number;
let requests: Array<{ path: string; input: unknown }>;
// The server's refusal while a claimed run is unfinished (see the management accessor).
const unfinishedMessage =
  '1 run of this automation has started and not finished. Let it finish, or stop it in the ' +
  'workspace (or abandon it from the Runs view if it needs attention), then delete the ' +
  'automation again. Nothing was changed.';

/** What `automation.getProposal` returns for the chat proposal that created an automation. */
function acceptedProposal(id: string, agentDefinitionId: string) {
  return agentProposalSchema.parse({
    id,
    workspaceId: 'author',
    revision: 1,
    agentDefinitionId,
    sourceNames: {},
    specification: {
      name: 'Investigate labeled issues',
      instructions: 'Investigate labeled issues and propose a focused fix.',
      executionConfig: { version: 1 },
      triggers: [
        {
          id: 'local-github',
          type: 'GITHUB_ISSUE',
          connectionId: 'github-connection',
          description: 'Investigate labeled issues',
          config: {
            version: 1,
            repositoryIds: ['repo-1'],
            actions: ['labeled'],
            labels: ['agent'],
          },
        },
      ],
    },
  });
}
function trpcError(code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'NOT_FOUND', message: string) {
  const statuses = { CONFLICT: 409, PRECONDITION_FAILED: 412, NOT_FOUND: 404 } as const;
  return new TRPCClientError(message, {
    result: { error: { message, code: -32_000, data: { code, httpStatus: statuses[code] } } },
  });
}
function remove(input: unknown) {
  const args = agentActivationInputSchema.parse(input);
  if (deleted) {
    throw trpcError('NOT_FOUND', 'Automation not found in this project.');
  }
  if (args.expectedManagementRevision !== saved.managementRevision) {
    throw trpcError('CONFLICT', 'This automation changed. Reload it and try again.');
  }
  if (unfinishedRuns) {
    throw trpcError('PRECONDITION_FAILED', unfinishedMessage);
  }
  deleted = true;
  return { deleted: true };
}
function respond(path: string, input: unknown) {
  switch (path) {
    case 'automation.delete':
      return remove(input);
    case 'automation.get':
      if (deleted) {
        throw trpcError('NOT_FOUND', 'Automation not found in this project.');
      }
      return saved;
    case 'automation.list':
      return { items: deleted ? [] : [eventSummaryFixture(saved)], nextCursor: null };
    case 'automation.runs':
    case 'automation.evaluations':
      if (deleted) {
        throw trpcError('NOT_FOUND', 'Automation not found in this project.');
      }
      return { items: [], nextCursor: null };
    case 'automation.navigationSummary':
      return { totalCount: deleted ? 0 : 1, failedCount: 0 };
    case 'periodicTask.navigationSummary':
      return { totalCount: 0, failedCount: 0 };
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
function dialog() {
  return document.querySelector('[role="alertdialog"]');
}
async function dialogButton(text: string) {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === text
  );
  if (!found) {
    throw new Error(`Missing dialog button ${text}`);
  }
  await act(() => found.click());
}
const deletes = () =>
  requests
    .filter((item) => item.path === 'automation.delete')
    .map((item) => agentActivationInputSchema.parse(item.input));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved = managedAgentSchema.parse({
    ...eventAgentFixture(),
    isEnabled: true,
    configuredTriggers: eventAgentFixture().configuredTriggers.map((trigger) =>
      triggerInBackendState(trigger, 'ACTIVE')
    ),
  });
  deleted = false;
  archived = false;
  unfinishedRuns = 0;
  requests = [];
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

it('confirms what is removed and kept, deletes with the loaded revision and returns to the list', async () => {
  await render();
  // A chat proposal card that created this automation; deleting removes the proposal.
  const proposal = getQueryKey(
    trpc.automation.getProposal,
    { workspaceId: 'author', proposalId: 'proposal' },
    'query'
  );
  queryClient.setQueryData(proposal, acceptedProposal('proposal', 'event-agent'));
  const unrelated = getQueryKey(
    trpc.automation.getProposal,
    { workspaceId: 'author', proposalId: 'other' },
    'query'
  );
  const other = acceptedProposal('other', 'other-automation');
  queryClient.setQueryData(unrelated, other);

  // The rail's count of event automations.
  const summary = getQueryKey(trpc.automation.navigationSummary, { projectId: 'owner' }, 'query');
  queryClient.setQueryData(summary, { totalCount: 1, failedCount: 0 });

  await act(() => button('Delete').click());
  expect(deletes()).toEqual([]);
  const text = dialog()?.textContent ?? '';
  expect(text).toContain('Delete Investigate labeled issues?');
  expect(text).toContain('its triggers, its run and event history, and the saved proposal');
  expect(text).toContain(
    'Workspaces its runs started are kept, with their chats and pull requests'
  );
  expect(text).toContain('Queued runs are cancelled');

  await dialogButton('Delete automation');
  await waitForReact(() => expect(dialog()).toBeNull());
  expect(deletes()).toEqual([
    { projectId: 'owner', agentId: 'event-agent', expectedManagementRevision: 2 },
  ]);
  await waitForReact(() =>
    expect(container.querySelector('output')?.textContent).toBe('/projects/owner/agents?kind=event')
  );
  expect(container.querySelector('main h2')).toBeNull();
  expect(container.textContent).not.toContain('Automation not found');
  expect(container.textContent).not.toContain('Investigate labeled issues');
  await waitForReact(() => expect(queryClient.getQueryState(summary)?.isInvalidated).toBe(true));
  expect(queryClient.getQueryData(proposal)).toBeUndefined();
  expect(queryClient.getQueryData(unrelated)).toEqual(other);
  expect(requests.some((item) => item.path === 'periodicTask.delete')).toBe(false);
});

it('keeps the dialog open with the server reason while a started run is unfinished', async () => {
  unfinishedRuns = 1;
  await render();
  await act(() => button('Delete').click());
  await dialogButton('Delete automation');
  await waitForReact(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(unfinishedMessage)
  );
  expect(dialog()?.textContent).toContain("Couldn't delete this automation.");
  expect(container.querySelector('output')?.textContent).toBe(
    '/projects/owner/agents/event-agent?kind=event'
  );
  expect(container.querySelector('main h2')?.textContent).toBe(saved.name);
  // The run finishes; deleting again succeeds.
  unfinishedRuns = 0;
  await dialogButton('Delete automation');
  await waitForReact(() => expect(dialog()).toBeNull());
  expect(deletes()).toHaveLength(2);
});

it('offers a reload on a conflict and deletes with the reloaded revision', async () => {
  await render();
  saved = { ...saved, managementRevision: 3 };
  await act(() => button('Delete').click());
  await dialogButton('Delete automation');
  await waitForReact(() =>
    expect(dialog()?.textContent).toContain('This automation changed since it was loaded.')
  );
  await dialogButton('Reload automation');
  await waitForReact(() =>
    expect(dialog()?.textContent).not.toContain('This automation changed since it was loaded.')
  );
  await dialogButton('Delete automation');
  await waitForReact(() => expect(dialog()).toBeNull());
  expect(deletes().map((input) => input.expectedManagementRevision)).toEqual([2, 3]);
});

it('disables Delete in an archived project', async () => {
  archived = true;
  await render();
  expect(button('Delete').disabled).toBe(true);
});
