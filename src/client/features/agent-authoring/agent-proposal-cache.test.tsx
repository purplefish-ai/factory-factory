// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateSavedAgentQueries } from '@/client/lib/agent-query-cache';
import { trpc } from '@/client/lib/trpc';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { waitForReact } from '@/test-utils/react-act';
import { AgentProposalCard } from './agent-proposal-card';

const input = { workspaceId: 'author-workspace', proposalId: 'proposal' };
const proposal = agentProposalSchema.parse({
  id: input.proposalId,
  workspaceId: input.workspaceId,
  revision: 1,
  agentDefinitionId: 'saved-id',
  sourceNames: {},
  specification: {
    name: 'Saved proposal',
    instructions: 'Original',
    executionConfig: { version: 1 },
    triggers: [
      {
        id: 'local-id',
        type: 'GITHUB_ISSUE',
        connectionId: 'github',
        description: 'Issue',
        config: { version: 1, repositoryIds: ['repo'], actions: ['labeled'] },
      },
    ],
  },
});
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let requests: { path: string; input: unknown }[];
let finish: (() => void) | undefined;
let wait: Promise<void> | undefined;
let ownerFailure: boolean;
let invalidate: (() => Promise<unknown>) | undefined;
function Probe() {
  const utils = trpc.useUtils();
  invalidate = () => invalidateSavedAgentQueries(utils, 'owner-project', 'saved-id');
  return null;
}
async function respond(path: string) {
  if (path === 'agent.getProposal') {
    return proposal;
  }
  if (path === 'workspace.get') {
    if (ownerFailure) {
      throw new Error('Owner unavailable');
    }
    return { projectId: 'owner-project' };
  }
  if (path === 'agent.update') {
    await wait;
    return { ...proposal, revision: 2 };
  }
  throw new Error(`Unexpected ${path}`);
}
async function render() {
  const transport = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            void respond(op.path).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error) => observer.error(error)
            );
          }),
    ],
  });
  await act(() =>
    root.render(
      <trpc.Provider client={transport} queryClient={client}>
        <QueryClientProvider client={client}>
          <Probe />
          <AgentProposalCard reference={{ type: 'agent_proposal', ...input }} />
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
async function click(text: string) {
  await act(() =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === text)?.click()
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  ownerFailure = false;
  wait = undefined;
  finish = undefined;
  invalidate = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
it('captures the authoring owner before updating and invalidates its saved caches after unmount', async () => {
  await render();
  await waitForReact(() => expect(container.textContent).toContain('Automation created'));
  const listKey = getQueryKey(trpc.agent.list, { projectId: 'owner-project' }, 'infinite');
  const detailKey = getQueryKey(
    trpc.agent.get,
    { projectId: 'owner-project', agentId: 'saved-id', retainedCursor: 'tail' },
    'query'
  );
  const summaryKey = getQueryKey(
    trpc.agent.navigationSummary,
    { projectId: 'owner-project' },
    'query'
  );
  const foreign = getQueryKey(trpc.agent.navigationSummary, { projectId: 'new-project' }, 'query');
  for (const key of [listKey, detailKey, summaryKey, foreign]) {
    client.setQueryData(key, {});
  }
  await click('Edit automation');
  wait = new Promise<void>((done) => {
    finish = done;
  });
  await act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  await waitForReact(() =>
    expect(requests.some((request) => request.path === 'agent.update')).toBe(true)
  );
  expect(requests.findIndex((request) => request.path === 'workspace.get')).toBeLessThan(
    requests.findIndex((request) => request.path === 'agent.update')
  );
  await act(() => root.render(null));
  await act(() => finish?.());
  await waitForReact(() => expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true));
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(summaryKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(foreign)?.isInvalidated).toBe(false);
});
it('refreshes matching validated proposal cards after a saved edit without inventing workspace identities', async () => {
  await render();
  await waitForReact(() => expect(container.textContent).toContain('Automation created'));
  const unrelated = getQueryKey(
    trpc.agent.getProposal,
    { workspaceId: 'other', proposalId: 'other' },
    'query'
  );
  const malformed = getQueryKey(
    trpc.agent.getProposal,
    { workspaceId: 'bad', proposalId: 'bad' },
    'query'
  );
  client.setQueryData(unrelated, {
    ...proposal,
    id: 'other',
    agentDefinitionId: 'different-agent',
  });
  client.setQueryData(malformed, { agentDefinitionId: 'saved-id' });
  await act(async () => {
    await invalidate?.();
  });
  await waitForReact(() =>
    expect(requests.filter((request) => request.path === 'agent.getProposal')).toHaveLength(2)
  );
  expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(client.getQueryState(malformed)?.isInvalidated).toBe(false);
});
it('shows an explicit owner load problem and never updates against sidebar selection', async () => {
  ownerFailure = true;
  await render();
  await waitForReact(() => expect(container.textContent).toContain('Automation created'));
  await click('Edit automation');
  await act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  await waitForReact(() =>
    expect(container.textContent).toContain("Couldn't load the authoring workspace project")
  );
  expect(requests.some((request) => request.path === 'agent.update')).toBe(false);
});
