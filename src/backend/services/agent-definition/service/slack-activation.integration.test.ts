import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { validatedIntent } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { Prisma } from '@prisma-gen/client';
import type { SlackSocketHandlers } from './slack-event-source';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let configService: typeof import('@/backend/services/config.service').configService;
let listSlackTargets: typeof import('../resources/agent-source-queries').listSlackTargets;
let projectId: string;
let definitionId: string;
let connectionId: string;
let triggerId: string;
let clock: Date;
let intakeEnabled: boolean;
let second: number;

const TEN_MINUTES = 10 * 60 * 1000;
const signal = () => new AbortController().signal;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  ({ configService } = await vi.importActual<typeof import('@/backend/services/config.service')>(
    '@/backend/services/config.service'
  ));
  ({ listSlackTargets } = await vi.importActual<typeof import('../resources/agent-source-queries')>(
    '../resources/agent-source-queries'
  ));
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.project.deleteMany();
  const project = await db.prisma.project.create({
    data: { name: 'Factory', slug: crypto.randomUUID(), repoPath: '/r', worktreeBasePath: '/w' },
  });
  projectId = project.id;
  definitionId = (
    await db.prisma.agentDefinition.create({
      data: { projectId, name: 'Responder', instructions: 'Help', isEnabled: false },
    })
  ).id;
  connectionId = (
    await db.prisma.agentConnection.create({
      data: {
        provider: 'SLACK',
        externalId: 'T1',
        name: 'Company',
        credentialsEncrypted: 'bot',
        appCredentialsEncrypted: 'app',
        appId: 'A1',
        sourceState: {
          create: {
            isReady: true,
            cursor: { version: 1, provider: 'SLACK', gaps: [] },
            health: { state: 'READY', reasonCode: null, updatedAt: new Date().toISOString() },
          },
        },
      },
    })
  ).id;
  triggerId = (
    await db.prisma.agentTrigger.create({
      data: {
        agentDefinitionId: definitionId,
        connectionId,
        type: 'SLACK_MESSAGE',
        description: 'Messages in support and ops',
        config: { version: 1, channelIds: ['C1', 'C2'] },
        isConfigured: true,
      },
    })
  ).id;
  clock = new Date();
  // Provider timestamps a little in the past, ordered by the integer part.
  second = Math.floor(clock.getTime() / 1000) - 600;
  intakeEnabled = true;
  contextReads = [];
  const limits = configService.getAgentRuntimeLimits();
  vi.spyOn(configService, 'getAgentRuntimeLimits').mockImplementation(() => ({
    ...limits,
    slackIntakeEnabled: intakeEnabled,
  }));
});

function activation() {
  return new runtime.AgentActivationService(
    { prepareBaseline: () => Promise.reject(new Error('No GitHub source here')) },
    () => clock
  );
}
/** Event IDs whose Slack context evaluation asked for; a test message must never be one. */
let contextReads: string[];
function evaluator() {
  return new runtime.AgentEventEvaluationService({
    resolveExecution: async () => ({ version: 1, provider: 'CLAUDE', model: 'sonnet' }),
    resolveSlackContext: (event) => {
      contextReads.push(event.id);
      return Promise.resolve({ status: 'RESOLVED', context: [] });
    },
    now: () => clock,
  });
}
async function evaluate() {
  // Each pass handles a bounded page; a few passes settle everything in these fixtures.
  for (let pass = 0; pass < 3; pass++) {
    await evaluator().evaluatePendingEvents(signal());
  }
}
const complete = () => activation().completeSlackPending(signal());
function trigger(id = triggerId) {
  return db.prisma.agentTrigger.findUniqueOrThrow({ where: { id } });
}
async function begin(options: { triggerIds?: string[]; slackSources?: unknown[] } = {}) {
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: definitionId },
  });
  await activation().begin(
    {
      projectId,
      agentId: definitionId,
      expectedManagementRevision: definition.managementRevision,
      definitionRevision: definition.definitionRevision,
      projectSource: { githubOwner: null, githubRepo: null },
      execution: validatedIntent(definition.definitionRevision).execution,
      triggerIds: options.triggerIds ?? [triggerId],
      slackSources: options.slackSources ?? [{ connectionId, workspaceId: 'T1', appId: 'A1' }],
      sourceNames: { [`${connectionId}:C1`]: '#support', [`${connectionId}:C2`]: '#ops' },
    },
    signal()
  );
}
async function code() {
  const row = await trigger();
  return runtime.agentPendingActivationSchema.parse(row.pendingActivation);
}
async function message() {
  const pending = await code();
  if (pending.provider !== 'SLACK') {
    throw new Error('Expected a Slack pending activation');
  }
  return `Factory Factory check ${pending.nonce}`;
}
/** A stored ordinary human message, exactly as the listener writes one. */
function post(
  channelId: string,
  offset: number,
  text: string,
  payload: Record<string, unknown> = {}
) {
  const eventTs = `${second + offset}.000100`;
  return runtime.ingestEvent({
    connectionId,
    providerEventId: `Ev-${channelId}-${offset}-${crypto.randomUUID()}`,
    payload: {
      version: 1,
      provider: 'SLACK',
      workspaceId: 'T1',
      appId: 'A1',
      channelId,
      action: 'message',
      eventTs,
      threadTs: null,
      actorType: 'HUMAN',
      actorId: 'U-human',
      subtype: null,
      text,
      occurredAt: new Date((second + offset) * 1000).toISOString(),
      observedAt: clock.toISOString(),
      sourceUrl: `https://slack.com/archives/${channelId}/p${eventTs.replace('.', '')}`,
      ...payload,
    },
  });
}
async function projected() {
  const agent = await new runtime.AgentManagementService().get({
    projectId,
    agentId: definitionId,
  });
  const row = agent.configuredTriggers.find((entry) => entry.id === triggerId);
  if (!row) {
    throw new Error('Trigger missing from the projection');
  }
  return row;
}
async function evaluations(eventId: string) {
  return await db.prisma.agentEvaluation.findMany({ where: { eventId } });
}

it('stores a ten-minute code before listening and shows the exact message for each channel', async () => {
  await begin();
  const row = await trigger();
  expect(row).toMatchObject({
    activationState: 'STARTING',
    activationGeneration: 1,
    isEnabled: false,
    activationBoundary: null,
  });
  const pending = await code();
  expect(pending).toMatchObject({
    provider: 'SLACK',
    activationGeneration: 1,
    connectionId,
    workspaceId: 'T1',
    appId: 'A1',
    expiresAt: new Date(clock.getTime() + TEN_MINUTES).toISOString(),
    channels: [
      { channelId: 'C1', name: '#support', eventTs: null },
      { channelId: 'C2', name: '#ops', eventTs: null },
    ],
  });
  expect(await projected()).toMatchObject({
    capability: { status: 'SUPPORTED' },
    pendingVerification: {
      message: await message(),
      expiresAt: pending.expiresAt,
      channels: [
        { channelId: 'C1', name: '#support', verified: false },
        { channelId: 'C2', name: '#ops', verified: false },
      ],
    },
  });
  // The listener now targets this trigger's channels.
  expect(await listSlackTargets(connectionId)).toEqual([
    { connectionId, channelIds: ['C1', 'C2'] },
  ]);
});

it('verifies each channel from its test message, activates after the last, and runs neither message', async () => {
  await begin();
  const text = await message();
  const first = await post('C1', 10, text);
  await complete();
  expect(await trigger()).toMatchObject({ activationState: 'STARTING', isEnabled: false });
  expect((await projected()).pendingVerification?.channels).toEqual([
    { channelId: 'C1', name: '#support', verified: true },
    { channelId: 'C2', name: '#ops', verified: false },
  ]);
  await evaluate();
  expect(await evaluations(first.eventId)).toEqual([]);

  const last = await post('C2', 20, ` ${text.toUpperCase()} `);
  await complete();
  const active = await trigger();
  expect(active).toMatchObject({
    activationState: 'ACTIVE',
    isEnabled: true,
    pendingActivation: null,
    pausedReasonCode: null,
    activationBoundary: {
      provider: 'SLACK',
      workspaceId: 'T1',
      appId: 'A1',
      channels: [
        { channelId: 'C1', eventTs: `${second + 10}.000100` },
        { channelId: 'C2', eventTs: `${second + 20}.000100` },
      ],
    },
  });
  expect((await projected()).pendingVerification).toBeNull();
  await evaluate();
  for (const event of [first, last]) {
    expect(await evaluations(event.eventId)).toMatchObject([
      { status: 'SKIPPED', reasonCode: 'BEFORE_ACTIVATION', runId: null },
    ]);
  }
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(contextReads).toEqual([]);
});

it('verifies through the listener: the STARTING trigger opens a socket and its test messages are stored', async () => {
  await begin();
  const text = await message();
  const socket: { handlers?: SlackSocketHandlers } = {};
  const source = new runtime.SlackEventSource({
    createSocket: (_appToken, handlers) => {
      socket.handlers = handlers;
      return {
        start: () => {
          handlers.onHello({ type: 'hello', connection_info: { app_id: 'A1' } });
          return Promise.resolve();
        },
        disconnect: () => Promise.resolve(),
      };
    },
    getAppCredentials: (id) =>
      Promise.resolve({ connectionId: id, workspaceId: 'T1', appId: 'A1', appToken: 'xapp-t' }),
    isEnabled: () => intakeEnabled,
    ingestEvent: (input) => runtime.ingestEvent(input),
  });
  source.start();
  try {
    await source.reconcileConnections(signal());
    const acknowledged: string[] = [];
    for (const [channel, offset] of [
      ['C1', 10],
      ['C2', 11],
    ] as const) {
      await socket.handlers?.onEnvelope({
        type: 'events_api',
        body: {
          type: 'event_callback',
          team_id: 'T1',
          api_app_id: 'A1',
          event_id: `Ev-${channel}`,
          event: {
            type: 'message',
            channel,
            user: 'U-human',
            text,
            ts: `${second + offset}.000100`,
          },
        },
        ack: () => {
          acknowledged.push(channel);
          return Promise.resolve();
        },
      });
    }
    expect(acknowledged).toEqual(['C1', 'C2']);
  } finally {
    await source.stop();
  }
  await complete();
  expect(await trigger()).toMatchObject({ activationState: 'ACTIVE', isEnabled: true });
});

it('holds messages after a verified channel until the last channel verifies, then runs them', async () => {
  await begin();
  const text = await message();
  await post('C1', 10, text);
  const heldInVerified = await post('C1', 11, 'Please look at the outage');
  const beforeOtherBoundary = await post('C2', 12, 'Before ops verified');
  await complete();
  await evaluate();
  expect(await db.prisma.agentEvaluation.count()).toBe(0);

  await post('C2', 13, text);
  const afterBoth = await post('C2', 14, 'After ops verified');
  await complete();
  expect((await trigger()).activationState).toBe('ACTIVE');
  await evaluate();
  expect(await evaluations(beforeOtherBoundary.eventId)).toMatchObject([
    { status: 'SKIPPED', reasonCode: 'BEFORE_ACTIVATION' },
  ]);
  const runs = await db.prisma.agentRun.findMany({ orderBy: { createdAt: 'asc' } });
  expect(runs.map((run) => run.eventId).sort()).toEqual(
    [heldInVerified.eventId, afterBoth.eventId].sort()
  );
});

it('expires after ten minutes and settles held messages as skipped', async () => {
  await begin();
  await post('C1', 10, await message());
  const held = await post('C1', 11, 'Held while ops is pending');
  clock = new Date(clock.getTime() + TEN_MINUTES);
  await complete();
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'ACTIVATION_EXPIRED',
    pendingActivation: null,
    activationBoundary: null,
    isEnabled: false,
  });
  await evaluate();
  expect(await evaluations(held.eventId)).toMatchObject([
    { status: 'SKIPPED', reasonCode: 'TRIGGER_DISABLED', runId: null },
  ]);
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('settles held messages as skipped when the automation is paused during verification', async () => {
  await begin();
  await post('C1', 10, await message());
  const held = await post('C1', 11, 'Held while ops is pending');
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: definitionId },
  });
  await activation().pause({
    projectId,
    agentId: definitionId,
    expectedManagementRevision: definition.managementRevision,
  });
  await evaluate();
  expect(await evaluations(held.eventId)).toMatchObject([{ status: 'SKIPPED', runId: null }]);
  expect(await trigger()).toMatchObject({ activationState: 'PAUSED', pendingActivation: null });
});

it('ignores a test message that arrives after its window, even when posted in a selected channel', async () => {
  await begin();
  const text = await message();
  await post('C1', 10, text);
  const late = await post('C2', 20, text, {
    observedAt: new Date(clock.getTime() + TEN_MINUTES + 1).toISOString(),
  });
  // The completion pass that sees the late message also sees the expired window.
  clock = new Date(clock.getTime() + TEN_MINUTES + 2);
  await complete();
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'ACTIVATION_EXPIRED',
  });
  await evaluate();
  expect(await evaluations(late.eventId)).toMatchObject([{ status: 'SKIPPED', runId: null }]);
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('accepts a test message observed inside the window when completion runs just after it', async () => {
  await begin();
  const text = await message();
  await post('C1', 10, text);
  await post('C2', 20, text, {
    observedAt: new Date(clock.getTime() + TEN_MINUTES - 1).toISOString(),
  });
  clock = new Date(clock.getTime() + TEN_MINUTES + 1000);
  await complete();
  expect((await trigger()).activationState).toBe('ACTIVE');
});

it('ignores look-alikes, other channels, other apps, bots, files and thread replies', async () => {
  await begin();
  const text = await message();
  await post('C3', 10, text);
  await post('C1', 11, `${text} please`);
  await post('C1', 12, text, { actorType: 'BOT' });
  await post('C1', 13, text, { appId: 'A2' });
  await post('C1', 14, text, { subtype: 'thread_broadcast' });
  await post('C1', 16, text, { subtype: 'file_share' });
  await post('C1', 17, text, { threadTs: `${second + 1}.000100` });
  await post('C1', 15, 'Factory Factory check abcd-efgh-jkmn');
  await complete();
  const pending = await code();
  expect(pending.provider === 'SLACK' && pending.channels.map((c) => c.eventTs)).toEqual([
    null,
    null,
  ]);
  expect((await trigger()).activationState).toBe('STARTING');
});

it('does nothing with a test message for a channel an edit removed', async () => {
  await begin();
  const text = await message();
  // What a trigger edit writes: new revision and configuration, paused on a new generation.
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      config: { version: 1, channelIds: ['C1'] },
      triggerRevision: { increment: 1 },
      activationState: 'PAUSED',
      activationGeneration: { increment: 1 },
      pendingActivation: Prisma.DbNull,
      isEnabled: false,
    },
  });
  const removed = await post('C2', 10, text);
  await post('C1', 11, text);
  await complete();
  expect(await trigger()).toMatchObject({ activationState: 'PAUSED', activationBoundary: null });
  await evaluate();
  expect(await evaluations(removed.eventId)).toMatchObject([{ status: 'SKIPPED', runId: null }]);
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('needs a fresh test message after a pause and re-enable', async () => {
  await begin();
  const old = await message();
  await post('C1', 10, old);
  await post('C2', 11, old);
  await complete();
  expect((await trigger()).activationState).toBe('ACTIVE');
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: definitionId },
  });
  await activation().pause({
    projectId,
    agentId: definitionId,
    expectedManagementRevision: definition.managementRevision,
  });
  await begin();
  const fresh = await message();
  expect(fresh).not.toBe(old);
  await post('C1', 20, old);
  await post('C2', 21, old);
  await complete();
  expect(await trigger()).toMatchObject({ activationState: 'STARTING', activationGeneration: 3 });
  expect((await projected()).pendingVerification?.channels.map((c) => c.verified)).toEqual([
    false,
    false,
  ]);
});

it("finds each channel's earliest test message even when another channel has many", async () => {
  await begin();
  const text = await message();
  for (let offset = 10; offset < 130; offset++) {
    await post('C1', offset, text);
  }
  await post('C2', 200, text);
  await complete();
  expect(await trigger()).toMatchObject({
    activationState: 'ACTIVE',
    activationBoundary: {
      channels: [
        { channelId: 'C1', eventTs: `${second + 10}.000100` },
        { channelId: 'C2', eventTs: `${second + 200}.000100` },
      ],
    },
  });
});

it('asks for a fresh test message when Enable finds an active trigger on another Slack app', async () => {
  await begin();
  const text = await message();
  await post('C1', 10, text);
  await post('C2', 11, text);
  await complete();
  expect((await trigger()).activationState).toBe('ACTIVE');
  // A new app-level token for another app; the active boundary still names the old one.
  await db.prisma.agentConnection.update({ where: { id: connectionId }, data: { appId: 'A2' } });
  await begin({ slackSources: [{ connectionId, workspaceId: 'T1', appId: 'A2' }] });
  expect(await trigger()).toMatchObject({
    activationState: 'STARTING',
    activationGeneration: 2,
    activationBoundary: null,
    pendingActivation: { appId: 'A2' },
  });
  // The same app keeps an active trigger listening.
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      activationState: 'ACTIVE',
      isEnabled: true,
      pendingActivation: Prisma.DbNull,
      activationBoundary: {
        provider: 'SLACK',
        workspaceId: 'T1',
        appId: 'A2',
        channels: [
          { channelId: 'C1', eventTs: `${second + 10}.000100` },
          { channelId: 'C2', eventTs: `${second + 11}.000100` },
        ],
      },
    },
  });
  await begin({ slackSources: [{ connectionId, workspaceId: 'T1', appId: 'A2' }] });
  expect(await trigger()).toMatchObject({ activationState: 'ACTIVE', activationGeneration: 2 });
});

it('never runs a test message for another automation listening in the same channel', async () => {
  const other = await db.prisma.agentDefinition.create({
    data: {
      projectId,
      name: 'Listener',
      instructions: 'Answer',
      isEnabled: true,
      validatedIntent: validatedIntent(),
    },
  });
  const listening = await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: other.id,
      connectionId,
      type: 'SLACK_MESSAGE',
      description: 'Every support message',
      config: { version: 1, channelIds: ['C1'] },
      isConfigured: true,
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: {
        provider: 'SLACK',
        workspaceId: 'T1',
        appId: 'A1',
        channels: [{ channelId: 'C1', eventTs: `${second}.000100` }],
      },
    },
  });
  await begin();
  const test = await post('C1', 10, await message());
  const ordinary = await post('C1', 11, 'An ordinary question');
  await evaluate();
  expect(
    await db.prisma.agentEvaluation.findMany({
      where: { eventId: test.eventId, triggerId: listening.id },
    })
  ).toMatchObject([{ status: 'SKIPPED', reasonCode: 'VERIFICATION_MESSAGE', runId: null }]);
  expect((await db.prisma.agentRun.findMany()).map((run) => run.eventId)).toEqual([
    ordinary.eventId,
  ]);
  // It is skipped before matching, so it never costs a Slack history read.
  expect(contextReads).toEqual([ordinary.eventId]);
});

it('starts no Slack trigger while intake is off or without the expected app', async () => {
  intakeEnabled = false;
  await expect(begin()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  intakeEnabled = true;
  await expect(begin({ slackSources: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    begin({ slackSources: [{ connectionId, workspaceId: 'T1', appId: 'A-other' }] })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    activationGeneration: 0,
    pendingActivation: null,
  });
  expect(
    (await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: definitionId } }))
      .validatedIntent
  ).toBeNull();
});
