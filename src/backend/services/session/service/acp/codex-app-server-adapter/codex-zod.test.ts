import { describe, expect, it } from 'vitest';
import {
  collabAgentToolCallItemSchema,
  collaborationModeListResponseSchema,
  configRequirementsReadResponseSchema,
  knownCodexNotificationSchema,
  knownCodexServerRequestSchema,
  modelListResponseSchema,
  subAgentActivityItemSchema,
  threadListResponseSchema,
  threadReadResponseSchema,
  threadStatusChangedNotificationSchema,
  turnStartResponseSchema,
} from './codex-zod';

describe('codex-zod', () => {
  it('parses known Codex notifications', () => {
    const parsed = knownCodexNotificationSchema.parse({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        delta: 'hello',
      },
    });

    expect(parsed.method).toBe('item/agentMessage/delta');
    if (parsed.method === 'item/agentMessage/delta') {
      expect(parsed.params.delta).toBe('hello');
    }
  });

  it('parses reasoning summary text delta notifications', () => {
    const parsed = knownCodexNotificationSchema.parse({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        delta: '**Thinking**',
      },
    });

    expect(parsed.method).toBe('item/reasoning/summaryTextDelta');
    if (parsed.method === 'item/reasoning/summaryTextDelta') {
      expect(parsed.params.delta).toBe('**Thinking**');
    }
  });

  it('rejects malformed known notification payload', () => {
    const parsed = knownCodexNotificationSchema.safeParse({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 99,
        delta: 'hello',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('parses approval server requests', () => {
    const parsed = knownCodexServerRequestSchema.parse({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'item_1',
      },
    });

    expect(parsed.method).toBe('item/fileChange/requestApproval');
  });

  it('parses typed user-input approval requests', () => {
    const parsed = knownCodexServerRequestSchema.parse({
      id: 2,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        questions: [
          {
            id: 'choice',
            header: 'Pick one',
            question: 'Select an option',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Allow', description: 'Continue' },
              { label: 'Deny', description: 'Stop' },
            ],
          },
        ],
      },
    });

    expect(parsed.method).toBe('item/tool/requestUserInput');
    if (parsed.method === 'item/tool/requestUserInput') {
      expect(parsed.params.questions[0]?.options?.[0]?.label).toBe('Allow');
    }
  });

  it('parses model/list responses', () => {
    const parsed = modelListResponseSchema.parse({
      data: [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          description: 'Default model',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'medium', description: 'Balanced' },
          ],
          inputModalities: ['text'],
          isDefault: true,
        },
      ],
      nextCursor: null,
    });

    expect(parsed.data[0]?.id).toBe('gpt-5');
    expect(parsed.data[0]?.isDefault).toBe(true);
  });

  it('parses model/list responses when reasoning-effort fields are omitted', () => {
    const parsed = modelListResponseSchema.parse({
      data: [
        {
          id: 'legacy-local',
          displayName: 'Legacy Local',
          description: 'No reasoning support',
          inputModalities: ['text'],
          isDefault: false,
        },
        {
          id: 'gpt-5-lite',
          displayName: 'GPT-5 Lite',
          description: 'Supports reasoning without metadata',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium', description: null },
          ],
          isDefault: true,
        },
      ],
      nextCursor: null,
    });

    expect(parsed.data[0]?.defaultReasoningEffort).toBeUndefined();
    expect(parsed.data[1]?.supportedReasoningEfforts?.[0]?.description).toBeUndefined();
    expect(parsed.data[1]?.supportedReasoningEfforts?.[1]?.description).toBeNull();
  });

  it('parses thread/read responses used for session replay', () => {
    const parsed = threadReadResponseSchema.parse({
      thread: {
        id: 'thread_1',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                type: 'userMessage',
                id: 'item_user_1',
                content: [{ type: 'text', text: 'Hello' }],
              },
              {
                type: 'agentMessage',
                id: 'item_agent_1',
                text: 'Hi there',
              },
              {
                type: 'commandExecution',
                id: 'item_cmd_1',
                command: 'ls -la',
              },
            ],
          },
        ],
      },
    });

    expect(parsed.thread.turns[0]?.items).toHaveLength(3);
  });

  it('accepts additive provider turn statuses at read and live boundaries', () => {
    const read = threadReadResponseSchema.parse({
      thread: {
        id: 'thread_1',
        turns: [{ id: 'turn_1', status: 'pausedByProvider', items: [] }],
      },
    });
    const started = turnStartResponseSchema.parse({
      turn: { id: 'turn_2', status: 'queuedByProvider' },
    });
    const completed = knownCodexNotificationSchema.parse({
      method: 'turn/completed',
      params: {
        threadId: 'thread_1',
        turn: { id: 'turn_3', status: 'supersededByProvider', items: [] },
      },
    });

    expect(read.thread.turns[0]?.status).toBe('pausedByProvider');
    expect(started.turn.status).toBe('queuedByProvider');
    expect(completed.method).toBe('turn/completed');
  });

  it('parses parent-scoped thread/list fields while preserving additive fields', () => {
    const parsed = threadListResponseSchema.parse({
      data: [
        {
          id: 'child-thread-1',
          parentThreadId: 'parent-thread-1',
          name: 'reviewer',
          agentNickname: 'swift-otter',
          preview: 'Review the change',
          createdAt: 1_786_089_600,
          updatedAt: 1_786_093_200,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
          turns: [],
          futureThreadField: 'retained',
        },
      ],
      nextCursor: null,
      futureResponseField: 'retained',
    });

    expect(parsed.data[0]).toMatchObject({
      id: 'child-thread-1',
      parentThreadId: 'parent-thread-1',
      futureThreadField: 'retained',
    });
    expect(parsed.futureResponseField).toBe('retained');
  });

  it('parses thread status changes used for sub-agent invalidation', () => {
    const parsed = threadStatusChangedNotificationSchema.parse({
      method: 'thread/status/changed',
      params: {
        threadId: 'child-thread-1',
        status: { type: 'systemError', futureStatusField: true },
      },
    });

    expect(parsed.params).toMatchObject({
      threadId: 'child-thread-1',
      status: { type: 'systemError', futureStatusField: true },
    });
  });

  it('parses sub-agent activity items while preserving unknown fields', () => {
    const parsed = subAgentActivityItemSchema.parse({
      type: 'subAgentActivity',
      id: 'item_subagent_1',
      agentThreadId: 'child_1',
      agentPath: 'review/security',
      kind: 'started',
      futureField: 'retained',
    });

    expect(parsed.agentThreadId).toBe('child_1');
    expect(parsed.futureField).toBe('retained');
  });

  it('parses collaboration tool calls while preserving unknown fields', () => {
    const parsed = collabAgentToolCallItemSchema.parse({
      type: 'collabAgentToolCall',
      id: 'item_collab_1',
      tool: 'spawnAgent',
      senderThreadId: 'parent_thread_1',
      receiverThreadIds: ['child_1'],
      status: 'inProgress',
      futureField: 'retained',
    });

    expect(parsed.receiverThreadIds).toEqual(['child_1']);
    expect(parsed.futureField).toBe('retained');
  });

  it('parses configRequirements/read responses', () => {
    const parsed = configRequirementsReadResponseSchema.parse({
      requirements: {
        allowedApprovalPolicies: ['on-failure', 'on-request'],
      },
    });

    expect(parsed.requirements?.allowedApprovalPolicies).toEqual(['on-failure', 'on-request']);
  });

  it('parses collaborationMode/list responses', () => {
    const parsed = collaborationModeListResponseSchema.parse({
      data: [
        {
          name: 'Plan',
          mode: 'plan',
          model: null,
          reasoning_effort: 'medium',
          developer_instructions: 'Plan mode instructions',
        },
      ],
      nextCursor: null,
    });

    expect(parsed.data[0]?.mode).toBe('plan');
    expect(parsed.data[0]?.reasoning_effort).toBe('medium');
  });
});
