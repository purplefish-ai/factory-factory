import { z } from 'zod';
import { agentSpecificationSchema, type AgentProposal } from '@/shared/agent-proposal';

export function draftFrom(proposal: AgentProposal) {
  return {
    revision: proposal.revision,
    baseline: proposal.specification,
    executionConfig: JSON.stringify(proposal.specification.executionConfig, null, 2),
    name: proposal.specification.name,
    instructions: proposal.specification.instructions,
    triggers: proposal.specification.triggers.map(
      ({ description, filterInstructions, isEnabled: _enabled, ...event }) => ({
        key: crypto.randomUUID(),
        description,
        filterInstructions: filterInstructions ?? '',
        event: JSON.stringify(event, null, 2),
      })
    ),
  };
}
export type AgentProposalDraft = ReturnType<typeof draftFrom>;

export function specificationFromDraft(draft: AgentProposalDraft) {
  const triggers = draft.triggers.map((trigger) => ({
    ...z.record(z.string(), z.unknown()).parse(JSON.parse(trigger.event)),
    description: trigger.description,
    filterInstructions: trigger.filterInstructions.trim() || null,
    isEnabled: false,
  }));
  const executionConfig: unknown = JSON.parse(draft.executionConfig);
  return agentSpecificationSchema.parse({
    name: draft.name,
    instructions: draft.instructions,
    executionConfig,
    triggers,
  });
}

/** Keep local edits while applying conversational edits to untouched fields. */
export function reconcileDraft(
  draft: AgentProposalDraft,
  latest: AgentProposal,
  discardLocalEvents = false
) {
  const next = draftFrom(latest);
  const baseline = draftFrom({ ...latest, specification: draft.baseline });
  const signature = (triggers: AgentProposalDraft['triggers']) =>
    JSON.stringify(triggers.map(({ key: _key, ...fields }) => fields));
  const localEventsChanged = signature(draft.triggers) !== signature(baseline.triggers);
  const remoteEventsChanged =
    JSON.stringify(draft.baseline.triggers) !== JSON.stringify(latest.specification.triggers);
  if (localEventsChanged && remoteEventsChanged && !discardLocalEvents) {
    throw new Error(
      'The event configuration changed in chat while you edited it here. Your edits are preserved. Review or copy them before discarding local event edits.'
    );
  }
  for (const field of ['name', 'instructions', 'executionConfig'] as const) {
    if (draft[field] !== baseline[field]) {
      next[field] = draft[field];
    }
  }
  if (localEventsChanged && !discardLocalEvents) {
    next.triggers = draft.triggers;
  }
  return next;
}
