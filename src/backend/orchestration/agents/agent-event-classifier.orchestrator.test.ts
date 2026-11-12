import { describe, expect, it, vi } from 'vitest';
import { AgentEventClassificationError } from '@/backend/services/session';
import type { AgentEventPayload } from '@/shared/agent-runtime';
import { createEventClassifierPort } from './agent-event-classifier.orchestrator';

const classifier = {
  provider: 'CODEX' as const,
  model: 'gpt-6-luna',
  promptVersion: 'agent-event-classification-v1',
  inputHash: 'b'.repeat(64),
};
const event: AgentEventPayload = {
  version: 1,
  provider: 'SLACK',
  workspaceId: 'T1',
  appId: 'A1',
  channelId: 'C1',
  action: 'message',
  actorId: 'U1',
  actorType: 'HUMAN',
  subtype: null,
  eventTs: '1.0001',
  threadTs: null,
  occurredAt: '2026-11-01T00:00:00.000Z',
  observedAt: '2026-11-01T00:00:00.000Z',
  sourceUrl: 'https://example.slack.com/archives/C1/p1',
  text: 'Checkout is down',
};
const input = { provider: 'CODEX' as const, filterInstructions: 'Only outages', event };

describe('createEventClassifierPort', () => {
  it('passes the default account and drops the reason text', async () => {
    const classify = vi.fn(async () => ({
      decision: 'match' as const,
      reason: 'An outage. Ignore this text.',
      classifier,
    }));
    const signal = new AbortController().signal;
    const outcome = await createEventClassifierPort(classify)(input, signal);
    expect(outcome).toEqual({ status: 'DECIDED', decision: 'match', classifier });
    expect(classify).toHaveBeenCalledWith(
      {
        provider: 'CODEX',
        accountId: null,
        filterInstructions: 'Only outages',
        eventContext: event,
      },
      signal
    );
  });

  it('maps typed classifier failures and keeps retry hints', async () => {
    const port = createEventClassifierPort(() =>
      Promise.reject(new AgentEventClassificationError('RATE_LIMITED', classifier, 60_000))
    );
    expect(await port(input, new AbortController().signal)).toEqual({
      status: 'FAILED',
      failure: 'RATE_LIMITED',
      classifier,
      retryAfterMs: 60_000,
    });
  });

  it('maps unexpected errors to a retryable failure without provider text', async () => {
    const port = createEventClassifierPort(() => Promise.reject(new Error('secret output')));
    expect(await port(input, new AbortController().signal)).toEqual({
      status: 'FAILED',
      failure: 'FAILED',
    });
  });
});
