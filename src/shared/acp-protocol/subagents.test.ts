import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_TOOL_META_KEY,
  SUBAGENTS_CAPABILITY_META_KEY,
  SUBAGENTS_CHANGED_METHOD,
  SUBAGENTS_LIST_METHOD,
  SUBAGENTS_READ_METHOD,
  subagentBrowseCapabilitySchema,
  subagentListParamsSchema,
  subagentListResultSchema,
  subagentReadParamsSchema,
  subagentReadResultSchema,
  subagentStatusSchema,
  subagentSummarySchema,
  subagentsChangedParamsSchema,
  subagentTranscriptUpdateSchema,
} from './index';

const validSummary = {
  id: 'subagent-1',
  name: 'Investigate protocol',
  status: 'running',
  createdAt: '2026-08-08T12:00:00.000Z',
  updatedAt: '2026-08-08T12:01:00.000Z',
  completedAt: null,
  latestActivity: 'Reading ACP definitions',
  resultPreview: null,
};

describe('ACP sub-agent inspection contract', () => {
  it('uses the factoryfactory.ai sub-agent namespace', () => {
    expect(SUBAGENTS_CAPABILITY_META_KEY).toBe('factoryfactory.ai/subagents');
    expect(SUBAGENT_TOOL_META_KEY).toBe('factoryfactory.ai/subagent');
    expect(SUBAGENTS_LIST_METHOD).toBe('factoryfactory.ai/subagents/list');
    expect(SUBAGENTS_READ_METHOD).toBe('factoryfactory.ai/subagents/read');
    expect(SUBAGENTS_CHANGED_METHOD).toBe('factoryfactory.ai/subagents/changed');
  });

  it('accepts only capability version one with every browse operation enabled', () => {
    expect(
      subagentBrowseCapabilitySchema.parse({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      })
    ).toEqual({ version: 1, list: true, read: true, notifications: true });

    expect(() =>
      subagentBrowseCapabilitySchema.parse({
        version: 2,
        list: true,
        read: true,
        notifications: true,
      })
    ).toThrow();
  });

  it.each([
    'starting',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ])('accepts the %s sub-agent lifecycle status', (status) => {
    expect(subagentStatusSchema.parse(status)).toBe(status);
  });

  it('rejects malformed summary identifiers, dates, and statuses while preserving additive fields', () => {
    expect(
      subagentSummarySchema.parse({
        ...validSummary,
        providerHint: 'future-compatible',
      })
    ).toMatchObject({ ...validSummary, providerHint: 'future-compatible' });

    expect(subagentSummarySchema.parse({ ...validSummary, name: '' }).name).toBe('');

    expect(() => subagentSummarySchema.parse({ ...validSummary, id: '' })).toThrow();
    expect(() =>
      subagentSummarySchema.parse({ ...validSummary, createdAt: 'not-a-date' })
    ).toThrow();
    expect(() => subagentSummarySchema.parse({ ...validSummary, status: 'unknown' })).toThrow();
  });

  it('validates list and read paging boundaries and applies their defaults', () => {
    expect(subagentListParamsSchema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
      limit: 50,
    });
    expect(
      subagentReadParamsSchema.parse({
        sessionId: 'session-1',
        subagentId: 'subagent-1',
        limit: 100,
      })
    ).toEqual({ sessionId: 'session-1', subagentId: 'subagent-1', limit: 100 });

    expect(() =>
      subagentListParamsSchema.parse({ sessionId: 'session-1', cursor: '', limit: 0 })
    ).toThrow();
    expect(() =>
      subagentReadParamsSchema.parse({
        sessionId: '',
        subagentId: '',
        cursor: '',
        limit: 101,
      })
    ).toThrow();
  });

  it('accepts direct list and read payloads', () => {
    expect(
      subagentListResultSchema.parse({ subagents: [validSummary], nextCursor: 'next-page' })
    ).toEqual({ subagents: [validSummary], nextCursor: 'next-page' });

    expect(
      subagentReadResultSchema.parse({
        updates: [
          { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Investigate' } },
        ],
        nextCursor: null,
      })
    ).toEqual({
      updates: [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Investigate' } },
      ],
      nextCursor: null,
    });
  });

  it('accepts every supported ACP transcript update and passthrough fields', () => {
    const updates = [
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Please investigate.' },
        providerField: 'kept',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will investigate.' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'First inspect the SDK.' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read ACP SDK types',
        kind: 'read',
        status: 'pending',
        locations: [{ path: '/tmp/types.gen.d.ts', line: 1 }],
        content: [{ type: 'content', content: { type: 'text', text: 'Reading' } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        title: null,
        kind: null,
        status: 'completed',
        locations: null,
        content: null,
      },
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'Inspect the SDK', priority: 'high', status: 'in_progress' }],
      },
    ] as const;

    expect(updates.map((update) => subagentTranscriptUpdateSchema.parse(update))).toEqual(updates);
  });

  it('rejects unsupported transcript updates and malformed tool and plan fields', () => {
    expect(() =>
      subagentTranscriptUpdateSchema.parse({
        sessionUpdate: 'usage_update',
        used: 1,
      })
    ).toThrow();
    expect(() =>
      subagentTranscriptUpdateSchema.parse({
        sessionUpdate: 'tool_call',
        toolCallId: '',
        title: '',
      })
    ).toThrow();
    expect(() =>
      subagentTranscriptUpdateSchema.parse({
        sessionUpdate: 'plan',
        entries: [{ content: 'Bad status', priority: 'high', status: 'unknown' }],
      })
    ).toThrow();
  });

  it('validates sub-agent change notifications', () => {
    expect(
      subagentsChangedParamsSchema.parse({
        sessionId: 'session-1',
        subagentId: 'subagent-1',
        change: 'completed',
      })
    ).toEqual({ sessionId: 'session-1', subagentId: 'subagent-1', change: 'completed' });

    expect(() =>
      subagentsChangedParamsSchema.parse({
        sessionId: 'session-1',
        subagentId: 'subagent-1',
        change: 'removed',
      })
    ).toThrow();
  });
});
