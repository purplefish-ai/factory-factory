import { describe, expect, it } from 'vitest';
import {
  chatIntentRecoverySchema,
  durableRecoverySchema,
  promptDispatchAttemptRecoverySchema,
} from './durable-recovery.schema';

const settings = {
  selectedModel: 'sonnet',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: true,
};
const submitted = {
  id: 'message',
  text: 'original request',
  timestamp: '2026-01-01T00:00:00.000Z',
  settings,
};
const intent = {
  id: 1,
  sessionId: 'session',
  messageId: 'message',
  fingerprint: 'opaque-original-fingerprint',
  submitted,
  desired: settings,
  revision: 1,
  status: 'uncertain',
  attemptId: 'attempt',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const attempt = {
  id: 'attempt',
  sessionId: 'session',
  members: [{ messageId: 'message', owner: 'human', revision: 1, message: submitted }],
  content: 'frozen aggregate prompt',
  effectiveSettings: settings,
  providerIdentity: { provider: 'CLAUDE', providerSessionId: 'native', accountId: 'original' },
  sendGeneration: 1,
  status: 'uncertain',
  evidence: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  settledAt: null,
};
function durable() {
  return {
    ...Object.fromEntries(
      Object.keys(durableRecoverySchema.shape).map((key) => [
        key,
        key === 'jsonStorage' ? { version: 1, jsonNulls: [] } : [],
      ])
    ),
    chatIntent: [intent],
    promptDispatchAttempt: [attempt],
  };
}

describe('durable chat owner decoding contract', () => {
  it.each(
    [
      null,
      [],
      {},
      { ...submitted, settings: null },
      { ...submitted, settings: { ...settings, reasoningEffort: 9 } },
      {
        ...submitted,
        attachments: [
          { id: 'file', name: 'file.txt', type: 'text/plain', size: 'large', data: 'text' },
        ],
      },
    ].map((value) => ({ value }))
  )('rejects malformed submitted JSON $value', ({ value }) => {
    expect(chatIntentRecoverySchema.safeParse({ ...intent, submitted: value }).success).toBe(false);
  });
  it.each(
    [
      null,
      [],
      {},
      { ...settings, selectedModel: 5 },
      { ...settings, thinkingEnabled: 'false' },
    ].map((value) => ({ value }))
  )('rejects malformed desired/effective settings $value', ({ value }) => {
    expect(chatIntentRecoverySchema.safeParse({ ...intent, desired: value }).success).toBe(false);
    expect(
      promptDispatchAttemptRecoverySchema.safeParse({ ...attempt, effectiveSettings: value })
        .success
    ).toBe(false);
  });
  it('rejects a submitted identity different from its indexed messageId', () => {
    expect(
      chatIntentRecoverySchema.safeParse({ ...intent, submitted: { ...submitted, id: 'other' } })
        .success
    ).toBe(false);
  });
  it('retains original JSON, opaque fingerprint and unknown frozen provenance rather than stripping or recanonicalizing', () => {
    const original = {
      ...durable(),
      chatIntent: [
        {
          ...intent,
          submitted: {
            ...submitted,
            provenance: { originalProvider: 'CLAUDE', nested: [1, null, 'old'] },
          },
          desired: { ...settings, providerMetadata: { unchanged: true } },
        },
      ],
      promptDispatchAttempt: [
        {
          ...attempt,
          effectiveSettings: { ...settings, providerDefaults: { model: 'original-model' } },
          members: [
            ...attempt.members,
            {
              messageId: 'external',
              owner: 'external',
              message: { frozenEvidence: ['arbitrary', 'json'] },
              receiptProvenance: { original: true },
            },
          ],
        },
      ],
    };
    const decoded: unknown = JSON.parse(JSON.stringify(original));
    expect(durableRecoverySchema.parse(decoded)).toEqual(original);
  });
  it('keeps frozen membership bound to its session and complete human intent set', () => {
    const committed = {
      ...durable(),
      chatIntent: [{ ...intent, status: 'committed' }],
      promptDispatchAttempt: [{ ...attempt, status: 'committed' }],
    };
    expect(durableRecoverySchema.safeParse(committed).success).toBe(true);
    expect(
      durableRecoverySchema.safeParse({
        ...committed,
        promptDispatchAttempt: [{ ...attempt, status: 'committed', sessionId: 'foreign' }],
      }).success
    ).toBe(false);
    expect(durableRecoverySchema.safeParse({ ...durable(), chatIntent: [] }).success).toBe(false);
    expect(
      durableRecoverySchema.safeParse({
        ...durable(),
        promptDispatchAttempt: [{ ...attempt, members: [attempt.members[0], attempt.members[0]] }],
      }).success
    ).toBe(false);
  });
});

it.each([
  { attemptId: null, attemptStatus: 'uncertain' },
  { attemptId: 'attempt', attemptStatus: 'committed' },
  { attemptId: 'attempt', attemptStatus: 'cancelled' },
  { attemptId: 'attempt', attemptStatus: 'queued' },
])(
  'rejects stranded uncertain human intent $attemptId/$attemptStatus',
  ({ attemptId, attemptStatus }) => {
    const result = durableRecoverySchema.safeParse({
      ...durable(),
      chatIntent: [{ ...intent, attemptId }],
      promptDispatchAttempt: attemptId ? [{ ...attempt, status: attemptStatus }] : [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        message: 'Uncertain chat intent requires its uncertain frozen dispatch attempt',
      })
    );
  }
);
