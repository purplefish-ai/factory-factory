import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import type { ToolSequence } from '@/lib/chat-protocol';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { ToolSequenceGroup } from './tool-info-renderer';

it('shows a proposal widget while ordinary tool activity is collapsed', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const proposal = agentProposalSchema.parse({
    id: 'proposal-1',
    workspaceId: 'workspace-1',
    revision: 1,
    agentDefinitionId: null,
    sourceNames: {},
    specification: {
      name: 'QA investigator',
      instructions: 'Compare packet edits.',
      triggers: [
        { type: 'SCHEDULE', description: 'Daily', config: { version: 1, cadence: 'DAILY' } },
      ],
    },
  });
  let current = proposal;
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'agent.getProposal') {
              throw new Error(`Unexpected request ${op.path}`);
            }
            observer.next({ result: { data: current } });
            observer.complete();
          }),
    ],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sequence: ToolSequence = {
    type: 'tool_sequence',
    id: 'seq',
    pairedCalls: [
      {
        id: 'call-1',
        name: 'mcp.factory-factory-child-workspace.propose_agent',
        input: {},
        status: 'success',
        result: {
          content: JSON.stringify({
            type: 'agent_proposal',
            proposalId: 'proposal-1',
            workspaceId: 'workspace-1',
          }),
          isError: false,
        },
      },
    ],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ToolSequenceGroup sequence={sequence} />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    await vi.waitFor(() => expect(container.textContent).toContain('Create agent'));
    expect(container.querySelector('button[data-state="closed"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Agent configuration"]')).not.toBeNull();
    current = {
      ...proposal,
      revision: 2,
      specification: {
        ...proposal.specification,
        instructions: 'New conversational instructions.',
      },
    };
    const revised: ToolSequence = {
      ...sequence,
      pairedCalls: sequence.pairedCalls.map((call) => ({
        ...call,
        result: {
          content: JSON.stringify({
            type: 'agent_proposal',
            proposalId: 'proposal-1',
            workspaceId: 'workspace-1',
            revision: 2,
          }),
          isError: false,
        },
      })),
    };
    await act(async () => {
      root.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ToolSequenceGroup sequence={revised} />
          </QueryClientProvider>
        </trpc.Provider>
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Load latest proposal'));
    await act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load latest proposal')
        ?.click()
    );
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Instructions"]')?.value).toBe(
      'New conversational instructions.'
    );
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
