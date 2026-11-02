import { z } from 'zod';
import {
  savedAgentSpecificationSchema,
  type SavedAgentSpecification,
} from '@/shared/agent-management';

/** React identity is separate from persisted identity; new events omit savedId. */
export function savedDraftFrom(specification: SavedAgentSpecification) {
  return {
    name: specification.name,
    instructions: specification.instructions,
    executionConfig: JSON.stringify(specification.executionConfig, null, 2),
    triggers: specification.triggers.map(
      ({ id, description, filterInstructions, isEnabled: _enabled, ...event }) => ({
        key: crypto.randomUUID(),
        savedId: id,
        description,
        filterInstructions: filterInstructions ?? '',
        event: JSON.stringify(event, null, 2),
      })
    ),
  };
}
export type SavedEventDraft = ReturnType<typeof savedDraftFrom>;
export function savedSpecificationFromDraft(draft: SavedEventDraft) {
  const executionConfig: unknown = JSON.parse(draft.executionConfig);
  return savedAgentSpecificationSchema.parse({
    name: draft.name,
    instructions: draft.instructions,
    executionConfig,
    triggers: draft.triggers.map((trigger) => ({
      ...z.record(z.string(), z.unknown()).parse(JSON.parse(trigger.event)),
      ...(trigger.savedId ? { id: trigger.savedId } : {}),
      description: trigger.description,
      filterInstructions: trigger.filterInstructions.trim() || null,
      isEnabled: false,
    })),
  });
}
export function parseSavedReplacement(value: string) {
  const parsed: unknown = JSON.parse(value);
  return savedAgentSpecificationSchema.parse(parsed);
}
