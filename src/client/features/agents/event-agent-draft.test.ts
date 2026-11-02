import { expect, it } from 'vitest';
import {
  savedDraftFrom,
  savedSpecificationFromDraft,
  parseSavedReplacement,
} from './event-agent-draft';
import { eventAgentFixture } from './event-agent.test-support';
it('preserves maximum-length persisted IDs, omission semantics and reordered saved identity', () => {
  const spec = eventAgentFixture().specification!;
  const longId = 'a'.repeat(256);
  const draft = savedDraftFrom({
    ...spec,
    triggers: [
      { ...spec.triggers[0]!, id: longId },
      { ...spec.triggers[0]!, id: 'second' },
    ],
  });
  draft.triggers.reverse();
  draft.triggers.push({
    ...draft.triggers[0]!,
    key: crypto.randomUUID(),
    savedId: undefined,
    description: 'New member',
  });
  const result = savedSpecificationFromDraft(draft);
  expect(result.executionConfig).toEqual({ version: 1 });
  expect(result.triggers.map((trigger) => trigger.id)).toEqual(['second', longId, undefined]);
  expect(result.triggers[2]).not.toHaveProperty('id');
});
it('rejects invalid JSON, historical actor restrictions and nullable effort rather than repairing it', () => {
  const spec = eventAgentFixture().specification!;
  const draft = savedDraftFrom(spec);
  draft.executionConfig = '{"version":1,"reasoningEffort":null}';
  expect(() => savedSpecificationFromDraft(draft)).toThrow();
  expect(() => parseSavedReplacement('')).toThrow();
  expect(() =>
    parseSavedReplacement(
      JSON.stringify({
        ...spec,
        triggers: [
          {
            ...spec.triggers[0],
            config: { ...spec.triggers[0]!.config, creatorIds: ['historic'] },
          },
        ],
      })
    )
  ).toThrow();
});
