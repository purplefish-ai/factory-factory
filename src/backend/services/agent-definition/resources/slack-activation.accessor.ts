import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentPausedReasonCode } from '@/shared/agent-management';
import {
  agentActivationBoundarySchema,
  agentEventPayloadSchema,
  agentSlackPendingActivationSchema,
  type AgentSlackPendingActivation,
} from '@/shared/agent-runtime';
import { agentTriggerInputSchema } from '@/shared/schemas/agent-definition.schema';
import { Prisma, type AgentEvent, type AgentTrigger } from '@prisma-gen/client';
import {
  activationSourceHealth,
  failStartingInTransaction,
  permitsPending,
  type StartingTrigger,
} from './agent-activation-fences';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  compareSlackTimestamps,
  runtimeTriggerInclude,
  type RuntimeTrigger,
} from './agent-runtime-guards';
import { createSlackVerificationCode, isSlackVerificationFor } from './slack-verification';

type Tx = Prisma.TransactionClient;
/** The workspace and app Enable validated for one Slack connection. */
export type SlackActivationSource = { connectionId: string; workspaceId: string; appId: string };
export type SlackActivationOutcome = 'ACTIVATED' | 'WAITING' | 'PAUSED' | 'GONE';
const MAX_CHANNELS = 100;
const candidateIds = z.array(z.object({ id: z.string() }));

/** The connection must still be the workspace and app Enable validated, with both tokens. */
async function assertSlackSource(tx: Tx, source: SlackActivationSource) {
  const connection = await tx.agentConnection.findUnique({ where: { id: source.connectionId } });
  if (
    !(
      connection?.provider === 'SLACK' &&
      connection.isEnabled &&
      connection.credentialsEncrypted &&
      connection.appCredentialsEncrypted &&
      connection.externalId === source.workspaceId &&
      connection.appId === source.appId
    )
  ) {
    throw new ApplicationError('CONFLICT', 'The Slack source changed. Retry.');
  }
}

/**
 * Moves a Slack trigger to a fresh STARTING generation that waits for a test
 * message in each selected channel. The code, expected workspace and app, and
 * revisions are stored here, before the listener opens for this trigger.
 */
async function startSlackTrigger(
  tx: Tx,
  trigger: AgentTrigger,
  input: {
    definitionRevision: number;
    source: SlackActivationSource;
    sourceNames: Record<string, string>;
    expiresAt: Date;
  }
) {
  await assertSlackSource(tx, input.source);
  const settings = agentTriggerInputSchema.safeParse({
    type: trigger.type,
    description: trigger.description,
    filterInstructions: trigger.filterInstructions,
    isEnabled: false,
    connectionId: trigger.connectionId,
    config: trigger.config,
  });
  if (
    !settings.success ||
    settings.data.type !== 'SLACK_MESSAGE' ||
    settings.data.connectionId !== input.source.connectionId
  ) {
    throw new ApplicationError('CONFLICT', 'The automation triggers changed. Retry.');
  }
  const channelIds = [...new Set(settings.data.config.channelIds)];
  if (channelIds.length > MAX_CHANNELS) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      `A Slack trigger can verify at most ${MAX_CHANNELS} channels.`
    );
  }
  const generation = trigger.activationGeneration + 1;
  const pending: AgentSlackPendingActivation = {
    version: 1,
    provider: 'SLACK',
    activationGeneration: generation,
    definitionRevision: input.definitionRevision,
    triggerRevision: trigger.triggerRevision,
    connectionId: input.source.connectionId,
    expiresAt: input.expiresAt.toISOString(),
    workspaceId: input.source.workspaceId,
    appId: input.source.appId,
    nonce: createSlackVerificationCode(),
    channels: channelIds.map((channelId) => ({
      channelId,
      name: input.sourceNames[`${input.source.connectionId}:${channelId}`] ?? null,
      eventTs: null,
    })),
  };
  await tx.agentTrigger.update({
    where: { id: trigger.id },
    data: {
      isEnabled: false,
      activationState: 'STARTING',
      activationGeneration: generation,
      activationBoundary: Prisma.DbNull,
      pendingActivation: agentSlackPendingActivationSchema.parse(pending),
      pausedReasonCode: null,
    },
  });
}

async function listStartingSlack(): Promise<StartingTrigger[]> {
  // A plain read: completion rechecks each generation under the ledger lock.
  const rows = await prisma.agentTrigger.findMany({
    where: { activationState: 'STARTING', type: 'SLACK_MESSAGE', connectionId: { not: null } },
    orderBy: { id: 'asc' },
    select: { id: true, connectionId: true, activationGeneration: true },
  });
  return rows.flatMap((row) =>
    row.connectionId
      ? [
          {
            triggerId: row.id,
            connectionId: row.connectionId,
            generation: row.activationGeneration,
          },
        ]
      : []
  );
}

/** Why this generation must return to PAUSED now, or undefined while it can still complete. */
function pauseReason(
  row: RuntimeTrigger,
  pending: AgentSlackPendingActivation
): AgentPausedReasonCode | null | undefined {
  const health = activationSourceHealth(row);
  if (health === 'RECOVERY_REQUIRED') {
    return 'SOURCE_RECOVERY_REQUIRED';
  }
  const connection = row.connection;
  if (
    health === 'INVALID' ||
    !(
      connection?.provider === 'SLACK' &&
      connection.isEnabled &&
      connection.credentialsEncrypted &&
      connection.appCredentialsEncrypted &&
      connection.externalId === pending.workspaceId &&
      connection.appId === pending.appId
    )
  ) {
    return 'SOURCE_ERROR';
  }
  return permitsPending(row, pending) ? undefined : null;
}

/**
 * The test message for this code: an ordinary root message from a person, with
 * no subtype, in a pending channel of the expected workspace and app, observed
 * inside the window. Stricter than trigger matching on purpose.
 */
function verifiedChannel(event: AgentEvent, pending: AgentSlackPendingActivation) {
  const parsed = agentEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.provider !== 'SLACK') {
    return null;
  }
  const payload = parsed.data;
  const channel = pending.channels.find((entry) => entry.channelId === payload.channelId);
  const accepted =
    event.connectionId === pending.connectionId &&
    channel?.eventTs === null &&
    payload.action === 'message' &&
    payload.actorType === 'HUMAN' &&
    payload.subtype === null &&
    // Only a root message: a reply or file share is not what the user was asked to post.
    payload.threadTs === null &&
    payload.workspaceId === pending.workspaceId &&
    payload.appId === pending.appId &&
    event.observedAt.getTime() <= Date.parse(pending.expiresAt) &&
    isSlackVerificationFor(payload.text, pending.nonce);
  return accepted ? { channelId: payload.channelId, eventTs: payload.eventTs } : null;
}

/** Records the earliest matching test message as each still-pending channel's boundary. */
async function verifyChannels(tx: Tx, pending: AgentSlackPendingActivation) {
  // One bounded lookup per pending channel, so a busy channel cannot crowd out another. The code
  // is unique to this generation; verifiedChannel applies every rule exactly afterwards.
  const ids: string[] = [];
  for (const channel of pending.channels.filter((entry) => entry.eventTs === null)) {
    const rows = candidateIds.parse(
      await tx.$queryRaw`
        SELECT id FROM AgentEvent
        WHERE connectionId = ${pending.connectionId} AND payload IS NOT NULL
          AND json_extract(payload, '$.channelId') = ${channel.channelId}
          AND json_extract(payload, '$.actorType') = 'HUMAN'
          AND json_extract(payload, '$.subtype') IS NULL
          AND json_extract(payload, '$.threadTs') IS NULL
          AND instr(lower(json_extract(payload, '$.text')), ${pending.nonce}) > 0
        ORDER BY observedAt, id LIMIT 100`
    );
    ids.push(...rows.map((row) => row.id));
  }
  const events = await tx.agentEvent.findMany({ where: { id: { in: ids } } });
  const earliest = new Map<string, string>();
  for (const event of events) {
    const match = verifiedChannel(event, pending);
    const current = match && earliest.get(match.channelId);
    if (match && (!current || compareSlackTimestamps(match.eventTs, current) < 0)) {
      earliest.set(match.channelId, match.eventTs);
    }
  }
  return {
    changed: earliest.size > 0,
    channels: pending.channels.map((channel) => ({
      ...channel,
      eventTs: channel.eventTs ?? earliest.get(channel.channelId) ?? null,
    })),
  };
}

/**
 * Applies test messages that arrived for one STARTING generation, then activates
 * it once every selected channel is verified, in one transaction that rechecks
 * everything that permits it. Messages observed after the window never count;
 * an unverified generation past its window returns to PAUSED.
 */
async function completeSlack(trigger: StartingTrigger, now: Date): Promise<SlackActivationOutcome> {
  return await ledgerTransaction(async (tx) => {
    const row = await tx.agentTrigger.findUnique({
      where: { id: trigger.triggerId },
      include: runtimeTriggerInclude,
    });
    if (row?.activationState !== 'STARTING' || row.activationGeneration !== trigger.generation) {
      return 'GONE';
    }
    const parsed = agentSlackPendingActivationSchema.safeParse(row.pendingActivation);
    if (!parsed.success || parsed.data.activationGeneration !== row.activationGeneration) {
      await failStartingInTransaction(tx, trigger, 'ACTIVATION_EXPIRED');
      return 'PAUSED';
    }
    const pending = parsed.data;
    const reason = pauseReason(row, pending);
    if (reason !== undefined) {
      await failStartingInTransaction(tx, trigger, reason);
      return 'PAUSED';
    }
    const { changed, channels } = await verifyChannels(tx, pending);
    const verified = channels.flatMap(({ channelId, eventTs }) =>
      eventTs === null ? [] : [{ channelId, eventTs }]
    );
    if (verified.length === channels.length) {
      const boundary = agentActivationBoundarySchema.parse({
        provider: 'SLACK',
        workspaceId: pending.workspaceId,
        appId: pending.appId,
        channels: verified,
      });
      await tx.agentTrigger.update({
        where: { id: row.id },
        data: {
          isEnabled: true,
          activationState: 'ACTIVE',
          activationBoundary: boundary,
          pendingActivation: Prisma.DbNull,
          pausedReasonCode: null,
        },
      });
      return 'ACTIVATED';
    }
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      await failStartingInTransaction(tx, trigger, 'ACTIVATION_EXPIRED');
      return 'PAUSED';
    }
    if (changed) {
      await tx.agentTrigger.update({
        where: { id: row.id },
        data: {
          pendingActivation: agentSlackPendingActivationSchema.parse({ ...pending, channels }),
        },
      });
    }
    return 'WAITING';
  });
}

export const slackActivationAccessor = {
  start: startSlackTrigger,
  listStarting: listStartingSlack,
  complete: completeSlack,
};
