import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createLedgerFixture,
  executionConfig,
} from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentRunInputSchema } from '@/shared/schemas/agent-definition.schema';
import type { AgentEvaluationPorts } from './agent-event-evaluation.service';

const TOKEN = 'xoxb-bot-token-never-stored';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let connectionId: string;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'SLACK',
      externalId: 'T1',
      name: 'Company',
      credentialsEncrypted: 'encrypted-bot-token',
      sourceState: { create: { isReady: true } },
    },
  });
  connectionId = connection.id;
  await setTrigger({ includeThread: true, nearbyMessageCount: 2 });
});

async function setTrigger(
  context: { includeThread: boolean; nearbyMessageCount: number },
  filterInstructions: string | null = null
) {
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: {
      type: 'SLACK_MESSAGE',
      connectionId,
      filterInstructions,
      config: { version: 1, channelIds: ['C1'], context },
      activationBoundary: {
        provider: 'SLACK',
        workspaceId: 'T1',
        appId: 'A1',
        channels: [{ channelId: 'C1', eventTs: '1600000000.000000' }],
      },
    },
  });
}

async function slackEvent(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const captured = await runtime.ingestEvent({
    connectionId,
    providerEventId: `Ev-${crypto.randomUUID()}`,
    payload: {
      version: 1,
      provider: 'SLACK',
      workspaceId: 'T1',
      appId: 'A1',
      channelId: 'C1',
      action: 'message',
      actorType: 'HUMAN',
      actorId: 'U-trigger',
      subtype: null,
      eventTs: '1700000500.000500',
      threadTs: '1700000000.000100',
      text: 'Please fix the checkout outage',
      sourceUrl:
        'https://slack.com/archives/C1/p1700000500000500?thread_ts=1700000000.000100&cid=C1',
      occurredAt: now,
      observedAt: now,
      ...overrides,
    },
  });
  return captured.eventId;
}

type Route = { status?: number; headers?: Record<string, string>; body: unknown };
function slackApi(routes: Record<string, Route[]>) {
  const calls: { method: string; channel: string | null }[] = [];
  const requests: {
    method: string;
    query: Record<string, string>;
    authorization: string | null;
  }[] = [];
  const request = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace('/api/', '');
    calls.push({ method, channel: url.searchParams.get('channel') });
    requests.push({
      method,
      query: Object.fromEntries(url.searchParams),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    const next = routes[method]?.shift();
    if (!next) {
      return Promise.reject(new Error(`Unexpected Slack call ${method}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers })
    );
  });
  const service = new runtime.SlackConnectionService(
    { encrypt: (value) => value, decrypt: () => TOKEN },
    request
  );
  return { calls, requests, service };
}
const ok = (messages: unknown[]): Route => ({
  body: { ok: true, messages, response_metadata: { next_cursor: '' } },
});
const threadPage = ok([
  {
    type: 'message',
    ts: '1700000000.000100',
    thread_ts: '1700000000.000100',
    user: 'U-root',
    text: 'Checkout fails',
  },
  {
    type: 'message',
    ts: '1700000100.000100',
    thread_ts: '1700000000.000100',
    bot_id: 'B-ci',
    subtype: 'bot_message',
    text: 'Build 42 red',
  },
]);
const historyPage = ok([
  { type: 'message', ts: '1700000400.000100', user: 'U-near', text: 'Payments look slow too' },
]);

const signal = () => new AbortController().signal;
function evaluator(
  service: { resolveEventContext: NonNullable<AgentEvaluationPorts['resolveSlackContext']> } | null,
  overrides: Partial<AgentEvaluationPorts> = {}
) {
  return new runtime.AgentEventEvaluationService({
    resolveExecution: async () => executionConfig,
    ...(service
      ? {
          resolveSlackContext: (event, config, abort) =>
            service.resolveEventContext(event, config, abort),
        }
      : {}),
    ...overrides,
  });
}

it('admits a run whose input carries the trigger, then the thread, then channel neighbours', async () => {
  const eventId = await slackEvent();
  const { requests, service } = slackApi({
    'conversations.replies': [threadPage],
    'conversations.history': [historyPage],
  });
  await evaluator(service).evaluatePendingEvents(signal());
  // Bounded to the selected channel and to messages before the trigger, with the bot token.
  expect(requests).toEqual([
    {
      method: 'conversations.replies',
      query: {
        channel: 'C1',
        ts: '1700000000.000100',
        latest: '1700000500.000500',
        inclusive: 'false',
        limit: '200',
      },
      authorization: `Bearer ${TOKEN}`,
    },
    {
      method: 'conversations.history',
      query: { channel: 'C1', latest: '1700000500.000500', inclusive: 'false', limit: '2' },
      authorization: `Bearer ${TOKEN}`,
    },
  ]);
  const evaluation = await db.prisma.agentEvaluation.findFirstOrThrow();
  expect(evaluation).toMatchObject({ status: 'MATCHED', reasonCode: 'DETERMINISTIC_MATCH' });
  const run = await db.prisma.agentRun.findFirstOrThrow();
  const input = agentRunInputSchema.parse(run.input);
  expect(input.context.map((item) => item.id)).toEqual([
    `${eventId}:source`,
    `${eventId}:message`,
    `${eventId}:thread`,
    `${eventId}:channel`,
  ]);
  expect(input.context[0]?.text).toContain('Slack message that started this run');
  expect(input.context[1]?.text).toBe('Please fix the checkout outage');
  expect(input.context[2]?.text).toContain('Thread start from person U-root');
  expect(input.context[2]?.text).toContain('Reply from bot B-ci');
  expect(input.context[3]?.text).toContain('From person U-near');
  const stored = JSON.stringify(await db.prisma.agentEvaluation.findMany()) + JSON.stringify(run);
  expect(stored).not.toContain(TOKEN);
});

it('records a missing history scope as a terminal error without a run or a classifier call', async () => {
  await setTrigger({ includeThread: true, nearbyMessageCount: 0 }, 'Only checkout outages');
  await slackEvent();
  const { service } = slackApi({
    'conversations.replies': [
      { body: { ok: false, error: 'missing_scope', needed: 'groups:history' } },
    ],
  });
  const classifyEvent = vi.fn();
  await evaluator(service, { classifyEvent, isClassifierProven: () => true }).evaluatePendingEvents(
    signal()
  );
  const evaluation = await db.prisma.agentEvaluation.findFirstOrThrow();
  expect(evaluation).toMatchObject({
    status: 'ERROR',
    reasonCode: 'SLACK_CONTEXT_MISSING_SCOPE',
    nextAttemptAt: null,
    runId: null,
  });
  expect(evaluation.explanation).toMatch(/channels:history.*groups:history/);
  expect(JSON.stringify(evaluation)).not.toContain(TOKEN);
  expect(classifyEvent).not.toHaveBeenCalled();
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('retries a rate-limited context read on the shared budget, honoring Retry-After', async () => {
  await slackEvent();
  const { service } = slackApi({
    'conversations.replies': [
      { status: 429, headers: { 'Retry-After': '120' }, body: { ok: false, error: 'ratelimited' } },
      threadPage,
    ],
    'conversations.history': [historyPage],
  });
  let now = new Date();
  const worker = evaluator(service, { now: () => now });
  await worker.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'ERROR',
    reasonCode: 'SLACK_CONTEXT_RATE_LIMITED',
    attemptCount: 1,
    nextAttemptAt: new Date(now.getTime() + 120_000),
  });
  expect(await db.prisma.agentRun.count()).toBe(0);
  now = new Date(now.getTime() + 60_000);
  await worker.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({ attemptCount: 1 });
  now = new Date(now.getTime() + 60_000);
  await worker.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'MATCHED',
    attemptCount: 2,
  });
  expect(await db.prisma.agentRun.count()).toBe(1);
});

it('resolves context before the classifier and admits the classified match with that context', async () => {
  await setTrigger({ includeThread: true, nearbyMessageCount: 0 }, 'Only checkout outages');
  const eventId = await slackEvent();
  const { calls, service } = slackApi({ 'conversations.replies': [threadPage] });
  const order: string[] = [];
  const classifyEvent = vi.fn<NonNullable<AgentEvaluationPorts['classifyEvent']>>(() => {
    order.push(`classify after ${calls.length} Slack call(s)`);
    return Promise.resolve({
      status: 'DECIDED',
      decision: 'match',
      classifier: {
        provider: 'CLAUDE',
        model: 'haiku',
        promptVersion: 'agent-event-classification-v2',
        inputHash: 'a'.repeat(64),
      },
    });
  });
  await evaluator(service, { classifyEvent, isClassifierProven: () => true }).evaluatePendingEvents(
    signal()
  );
  expect(order).toEqual(['classify after 1 Slack call(s)']);
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'MATCHED',
    reasonCode: 'SEMANTIC_FILTER_MATCH',
  });
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(agentRunInputSchema.parse(run.input).context.map((item) => item.id)).toEqual([
    `${eventId}:source`,
    `${eventId}:message`,
    `${eventId}:thread`,
  ]);
});

it('reads nothing from Slack for a root message that only asks for its thread', async () => {
  await setTrigger({ includeThread: true, nearbyMessageCount: 0 });
  const eventId = await slackEvent({
    threadTs: null,
    sourceUrl: 'https://slack.com/archives/C1/p1700000500000500',
  });
  const { calls, service } = slackApi({});
  await evaluator(service).evaluatePendingEvents(signal());
  expect(calls).toEqual([]);
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(agentRunInputSchema.parse(run.input).context.map((item) => item.id)).toEqual([
    `${eventId}:source`,
    `${eventId}:message`,
  ]);
});

it('fails closed when no context reader is wired', async () => {
  await slackEvent();
  await evaluator(null).evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'ERROR',
    reasonCode: 'SLACK_CONTEXT_UNAVAILABLE',
    nextAttemptAt: null,
  });
  expect(await db.prisma.agentRun.count()).toBe(0);
});
