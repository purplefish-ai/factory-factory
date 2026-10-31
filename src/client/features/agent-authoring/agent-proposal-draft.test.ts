import { expect, it } from 'vitest';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { draftFrom, reconcileDraft, specificationFromDraft } from './agent-proposal-draft';

it('requires explicit reconciliation when chat removes an event with local edits', () => {
  const proposal = agentProposalSchema.parse({
    id: 'proposal',
    workspaceId: 'workspace',
    revision: 1,
    agentDefinitionId: null,
    sourceNames: {},
    specification: {
      name: 'Investigator',
      instructions: 'Investigate bugs',
      triggers: [
        {
          type: 'SLACK_MESSAGE',
          connectionId: 'slack',
          description: 'Slack bugs',
          config: { version: 1, channelIds: ['C-bugs'] },
        },
        {
          type: 'GITHUB_ISSUE',
          connectionId: 'github',
          description: 'GitHub bugs',
          filterInstructions: 'GitHub-specific filter',
          config: { version: 1, repositoryIds: ['123'], actions: ['opened'] },
        },
      ],
    },
  });
  const draft = draftFrom(proposal);
  draft.instructions = 'Keep my local task edit.';
  draft.triggers[0]!.filterInstructions = 'Only packet-unlock reports';
  const latest = {
    ...proposal,
    revision: 2,
    specification: {
      ...proposal.specification,
      triggers: proposal.specification.triggers.slice(1),
    },
  };
  expect(() => reconcileDraft(draft, latest)).toThrow('event configuration changed');
  const reconciled = specificationFromDraft(reconcileDraft(draft, latest, true));
  expect(reconciled.instructions).toBe('Keep my local task edit.');
  expect(reconciled.triggers).toHaveLength(1);
  expect(reconciled.triggers[0]).toMatchObject({
    type: 'GITHUB_ISSUE',
    filterInstructions: 'GitHub-specific filter',
  });
});
