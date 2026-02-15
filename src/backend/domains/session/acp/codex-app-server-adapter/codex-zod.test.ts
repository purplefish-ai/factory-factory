import { describe, expect, it } from 'vitest';
import {
  collaborationModeListResponseSchema,
  configRequirementsReadResponseSchema,
  knownCodexNotificationSchema,
  knownCodexServerRequestSchema,
  modelListResponseSchema,
  threadReadResponseSchema,
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
