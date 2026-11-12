import { describe, expect, it, vi } from 'vitest';
import type { AgentTriggerInput } from '@/shared/schemas/agent-definition.schema';
import { triggerCapability } from './agent-management-projection';

vi.mock('./semantic-filter-gate', () => ({
  semanticFilterSupported: (provider: string | undefined) => provider === 'CLAUDE',
}));

const trigger: AgentTriggerInput = {
  type: 'GITHUB_ISSUE',
  description: 'Agent labels',
  isEnabled: false,
  filterInstructions: 'Only billing bugs',
  connectionId: 'connection',
  config: { version: 1, repositoryIds: ['repo'], actions: ['labeled'] },
};

describe('triggerCapability with natural-language filters', () => {
  it('stays unsupported unless the automation provider passed the classifier gate', () => {
    expect(triggerCapability(trigger, true, 'CODEX')).toMatchObject({
      status: 'UNSUPPORTED',
      reasonCode: 'UNSUPPORTED_SEMANTIC_FILTER',
    });
    expect(triggerCapability(trigger, true)).toMatchObject({
      reasonCode: 'UNSUPPORTED_SEMANTIC_FILTER',
    });
    expect(triggerCapability(trigger, true, 'CLAUDE')).toMatchObject({
      status: 'SUPPORTED',
      reasonCode: 'SUPPORTED',
    });
  });

  it('still applies the other capability checks to a proven provider', () => {
    expect(triggerCapability(trigger, false, 'CLAUDE')).toMatchObject({
      reasonCode: 'SOURCE_UNVERIFIED',
    });
    expect(
      triggerCapability(
        { ...trigger, config: { ...trigger.config, creatorIds: ['someone'] } },
        true,
        'CLAUDE'
      )
    ).toMatchObject({ reasonCode: 'UNSUPPORTED_ACTOR_FILTER' });
  });
});
