import { describe, expect, it } from 'vitest';
import { agentEventPayloadSchema } from './agent-runtime';

const stored = {
  version: 1,
  provider: 'GITHUB',
  repositoryId: 'repo',
  repositoryFullName: 'org/repo',
  action: 'labeled',
  actorId: 'human',
  creatorId: 'creator',
  occurredAt: '2026-11-01T12:00:00.000Z',
  observedAt: '2026-11-01T12:00:01.000Z',
  sourceUrl: 'https://github.com/org/repo/issues/1',
  issue: { number: 1, title: 'Bug', body: 'Details', addedLabel: 'agent' },
};

describe('agentEventPayloadSchema', () => {
  it('parses GitHub payloads stored before issue labels were captured', () => {
    expect(agentEventPayloadSchema.parse(stored)).toMatchObject({ issue: { labels: [] } });
  });

  it('keeps captured issue labels and bounds them', () => {
    const withLabels = { ...stored, issue: { ...stored.issue, labels: ['agent', 'bug'] } };
    expect(agentEventPayloadSchema.parse(withLabels)).toMatchObject({
      issue: { labels: ['agent', 'bug'] },
    });
    const tooMany = Array.from({ length: 101 }, (_, index) => `label-${index}`);
    for (const labels of [tooMany, ['x'.repeat(257)]]) {
      expect(
        agentEventPayloadSchema.safeParse({ ...stored, issue: { ...stored.issue, labels } }).success
      ).toBe(false);
    }
  });
});
