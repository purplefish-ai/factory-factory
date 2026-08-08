import { describe, expect, it } from 'vitest';
import { SUBAGENT_TOOL_META_KEY } from '@/shared/acp-protocol';
import { mapCodexSubagentToolItem } from './codex-subagent-mapper';

describe('mapCodexSubagentToolItem', () => {
  it.each([
    ['started', 'Start subagent security'],
    ['interacted', 'Interact with subagent security'],
    ['interrupted', 'Interrupt subagent security'],
  ] as const)('maps %s activity with a stable title', (activityKind, title) => {
    expect(
      mapCodexSubagentToolItem(
        {
          type: 'subAgentActivity',
          id: `item-${activityKind}`,
          agentThreadId: 'child-1',
          agentPath: 'review/security',
          kind: activityKind,
        },
        'parent-1'
      )
    ).toMatchObject({
      title,
      kind: 'other',
      locations: [],
      affectedSubagentIds: ['child-1'],
      meta: {
        [SUBAGENT_TOOL_META_KEY]: {
          id: 'child-1',
          parentSessionId: 'parent-1',
        },
      },
    });
  });

  it('maps a collab call with one receiver to the provider-neutral child metadata', () => {
    expect(
      mapCodexSubagentToolItem(
        {
          type: 'collabAgentToolCall',
          id: 'item-collab-single',
          tool: 'spawnAgent',
          senderThreadId: 'parent-thread-1',
          receiverThreadIds: ['child-1'],
          status: 'inProgress',
        },
        'parent-1'
      )
    ).toMatchObject({
      title: 'spawnAgent',
      kind: 'other',
      locations: [],
      affectedSubagentIds: ['child-1'],
      meta: {
        [SUBAGENT_TOOL_META_KEY]: {
          id: 'child-1',
          parentSessionId: 'parent-1',
        },
      },
    });
  });

  it('maps every collab receiver without inventing singular metadata', () => {
    const mapping = mapCodexSubagentToolItem(
      {
        type: 'collabAgentToolCall',
        id: 'item-collab-many',
        tool: 'sendMessage',
        senderThreadId: 'parent-thread-1',
        receiverThreadIds: ['child-1', 'child-2'],
        status: 'completed',
      },
      'parent-1'
    );

    expect(mapping).toMatchObject({
      title: 'sendMessage',
      kind: 'other',
      locations: [],
      affectedSubagentIds: ['child-1', 'child-2'],
    });
    expect(mapping?.meta).toBeUndefined();
  });

  it('ignores non-subagent items', () => {
    expect(
      mapCodexSubagentToolItem(
        { type: 'commandExecution', id: 'item-command', command: 'pwd' },
        'parent-1'
      )
    ).toBeNull();
  });
});
