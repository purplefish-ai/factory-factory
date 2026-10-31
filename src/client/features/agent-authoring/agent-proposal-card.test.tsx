// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { AgentProposalEditor } from './agent-proposal-card';

const proposal = agentProposalSchema.parse({
  id: 'proposal-1',
  workspaceId: 'workspace-1',
  revision: 1,
  agentDefinitionId: null,
  sourceNames: { 'slack-1:C-feedback': '#customer-feedback' },
  specification: {
    name: 'Bug investigator',
    instructions: 'Investigate reports.',
    triggers: [
      {
        type: 'SLACK_MESSAGE',
        connectionId: 'slack-1',
        description: 'Feedback messages',
        filterInstructions: 'Include human and automated bug reports.',
        config: { version: 1, channelIds: ['C-feedback'] },
      },
    ],
  },
});
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
function edit(label: string, value: string) {
  const input = document.querySelector(`[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing ${label}`);
  }
  const prototype =
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

it('creates with the user-edited instructions and filter, preserving event settings', async () => {
  const create = vi.fn().mockResolvedValue({ ...proposal, agentDefinitionId: 'agent-1' });
  await act(() => root.render(createElement(AgentProposalEditor, { proposal, onCreate: create })));
  expect(document.body.textContent).toContain('#customer-feedback');
  expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    'Create agent',
  ]);
  edit('Instructions', 'Investigate using the dev database.');
  edit('Filter 1', 'Investigate uncertain cases too.');
  await submit();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      revision: 1,
      proposalId: 'proposal-1',
      specification: expect.objectContaining({
        instructions: 'Investigate using the dev database.',
        triggers: [
          expect.objectContaining({
            filterInstructions: 'Investigate uncertain cases too.',
            config: expect.objectContaining({
              channelIds: ['C-feedback'],
              context: { includeThread: true, nearbyMessageCount: 0 },
            }),
          }),
        ],
      }),
    })
  );
  expect(document.body.textContent).toContain('Agent created');
  expect(document.querySelector('button')?.textContent).toBe('Edit agent');
});

it('preserves edits and surfaces a failed acceptance', async () => {
  await act(() =>
    root.render(
      createElement(AgentProposalEditor, {
        proposal,
        onCreate: () =>
          Promise.reject(new Error('This proposal changed. Reload it before continuing.')),
      })
    )
  );
  edit('Name', 'My edited investigator');
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('This proposal changed');
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('My edited investigator');
});

it('blocks invalid event JSON without sending a creation request', async () => {
  const create = vi.fn();
  await act(() => root.render(createElement(AgentProposalEditor, { proposal, onCreate: create })));
  edit('Event settings 1', '{invalid');
  await submit();
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});

it('updates the visible source summary when event settings are edited', async () => {
  await act(() => root.render(createElement(AgentProposalEditor, { proposal, onCreate: vi.fn() })));
  edit(
    'Event settings 1',
    JSON.stringify({
      type: 'SLACK_MESSAGE',
      connectionId: 'slack-1',
      config: { version: 1, channelIds: ['C-review'] },
    })
  );
  expect(document.body.textContent).toContain('C-review');
  expect(document.body.textContent).not.toContain('#customer-feedback');
});

it('disables creation while a request is pending', async () => {
  let finish: (value: typeof proposal) => void = () => undefined;
  const create = vi.fn(
    () =>
      new Promise<typeof proposal>((resolve) => {
        finish = resolve;
      })
  );
  await act(() => root.render(createElement(AgentProposalEditor, { proposal, onCreate: create })));
  await submit();
  expect(document.querySelector('button')?.disabled).toBe(true);
  await act(async () => {
    finish({ ...proposal, agentDefinitionId: 'agent-1' });
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain('Agent created');
});

it('allows editing an already-created agent through the same widget', async () => {
  const saved = { ...proposal, agentDefinitionId: 'agent-1' };
  const update = vi.fn(async (input) => ({
    ...saved,
    revision: 2,
    specification: input.specification,
  }));
  await act(() =>
    root.render(createElement(AgentProposalEditor, { proposal: saved, onCreate: update }))
  );
  await act(() => document.querySelector('button')?.click());
  edit('Instructions', 'Revised task instructions.');
  expect(document.querySelector('button')?.textContent).toBe('Save changes');
  await submit();
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      specification: expect.objectContaining({ instructions: 'Revised task instructions.' }),
    })
  );
  expect(document.body.textContent).toContain('Revised task instructions.');
});

it('combines local filter edits with newer conversational instructions', async () => {
  const create = vi.fn().mockResolvedValue({ ...proposal, agentDefinitionId: 'agent-1' });
  await act(() => root.render(createElement(AgentProposalEditor, { proposal, onCreate: create })));
  edit('Filter 1', 'Include uncertain human bug reports.');
  const revised = {
    ...proposal,
    revision: 2,
    specification: { ...proposal.specification, instructions: 'Use a fresh development database.' },
  };
  await act(() =>
    root.render(createElement(AgentProposalEditor, { proposal: revised, onCreate: create }))
  );
  expect(document.body.textContent).toContain('newer proposal');
  await act(() => document.querySelector('button')?.click());
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Instructions"]')?.value).toBe(
    'Use a fresh development database.'
  );
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Filter 1"]')?.value).toBe(
    'Include uncertain human bug reports.'
  );
  await submit();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      revision: 2,
      specification: expect.objectContaining({
        instructions: revised.specification.instructions,
        triggers: [
          expect.objectContaining({ filterInstructions: 'Include uncertain human bug reports.' }),
        ],
      }),
    })
  );
});
