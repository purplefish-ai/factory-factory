import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import type {
  AgentActivationInput,
  AgentNativeIntent,
  AgentPausedReasonCode,
} from '@/shared/agent-management';
import {
  agentActivationBoundarySchema,
  agentGithubPendingActivationSchema,
  type AgentGithubPendingActivation,
} from '@/shared/agent-runtime';
import { Prisma, type AgentTrigger } from '@prisma-gen/client';
import {
  activationSourceHealth,
  failStartingInTransaction,
  permitsPending,
  type StartingTrigger,
} from './agent-activation-fences';
import { ledgerTransaction } from './agent-ledger-transaction';
import { ownedAgent } from './agent-management.accessor';
import { runtimeTriggerInclude, type RuntimeTrigger } from './agent-runtime-guards';
import { pauseTriggers } from './agent-trigger-pause';
import { type SlackActivationSource, startSlackTrigger } from './slack-activation.accessor';

type Tx = Prisma.TransactionClient;
export type { StartingTrigger } from './agent-activation-fences';
export type BeginActivationInput = AgentActivationInput & {
  definitionRevision: number;
  /** The repository the sources were validated against, rechecked under the ledger lock. */
  projectSource: { githubOwner: string | null; githubRepo: string | null };
  execution: AgentNativeIntent;
  triggerIds: string[];
  /** The workspace and app each Slack connection was validated with, rechecked under the lock. */
  slackSources: SlackActivationSource[];
  /** Verified source names keyed `connectionId:channelId`, shown with the test message. */
  sourceNames: Record<string, string>;
};
export type ActivationExpiry = { githubMs: number; slackMs: number };
export type ActivationOutcome = 'ACTIVATED' | 'NEEDS_BASELINE' | 'WAITING' | 'PAUSED' | 'GONE';

async function claimManagementRevision(tx: Tx, input: AgentActivationInput) {
  const definition = await ownedAgent(tx, input.projectId, input.agentId);
  if (definition.managementRevision !== input.expectedManagementRevision) {
    throw new ApplicationError('CONFLICT', 'This automation changed. Reload it and try again.');
  }
  if (definition.managementRevision >= 2_147_483_647) {
    throw new ApplicationError('CONFLICT', 'The management revision is exhausted.');
  }
  return definition;
}

function startable(trigger: AgentTrigger, slackSources: SlackActivationSource[]) {
  if (!trigger.connectionId) {
    return false;
  }
  if (trigger.type === 'GITHUB_ISSUE') {
    return true;
  }
  return (
    trigger.type === 'SLACK_MESSAGE' &&
    slackSources.some((source) => source.connectionId === trigger.connectionId)
  );
}

async function loadSupported(
  tx: Tx,
  definitionId: string,
  triggerIds: string[],
  slackSources: SlackActivationSource[]
) {
  const triggers = await tx.agentTrigger.findMany({
    where: { agentDefinitionId: definitionId },
    orderBy: { id: 'asc' },
  });
  if (triggers.some((trigger) => trigger.isConfigured === null)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Save the complete configuration before enabling this automation.'
    );
  }
  const configured = triggers.filter((trigger) => trigger.isConfigured === true);
  const supported = configured.filter((trigger) => triggerIds.includes(trigger.id));
  if (
    supported.length !== new Set(triggerIds).size ||
    supported.some((trigger) => !startable(trigger, slackSources))
  ) {
    throw new ApplicationError('CONFLICT', 'The automation triggers changed. Retry.');
  }
  if (!supported.length) {
    throw new ApplicationError('PRECONDITION_FAILED', 'No trigger in this automation can start.');
  }
  return {
    supported,
    unsupportedIds: configured.filter((trigger) => !supported.includes(trigger)).map((t) => t.id),
  };
}

async function startTrigger(
  tx: Tx,
  trigger: AgentTrigger,
  definitionRevision: number,
  expiresAt: Date
): Promise<StartingTrigger | null> {
  if ((trigger.activationState === 'ACTIVE' && trigger.isEnabled) || !trigger.connectionId) {
    return null;
  }
  const generation = trigger.activationGeneration + 1;
  const pending: AgentGithubPendingActivation = {
    version: 1,
    provider: 'GITHUB',
    activationGeneration: generation,
    definitionRevision,
    triggerRevision: trigger.triggerRevision,
    connectionId: trigger.connectionId,
    expiresAt: expiresAt.toISOString(),
    baselineId: null,
  };
  await tx.agentTrigger.update({
    where: { id: trigger.id },
    data: {
      isEnabled: false,
      activationState: 'STARTING',
      activationGeneration: generation,
      activationBoundary: Prisma.DbNull,
      pendingActivation: agentGithubPendingActivationSchema.parse(pending),
      pausedReasonCode: null,
    },
  });
  return { triggerId: trigger.id, connectionId: trigger.connectionId, generation };
}

/**
 * Persists the validated intent and moves each supported trigger to a fresh
 * STARTING generation. Already-ACTIVE supported triggers keep listening;
 * configured triggers that are not supported are paused.
 */
async function begin(input: BeginActivationInput, now: Date, expiry: ActivationExpiry) {
  return await ledgerTransaction(async (tx) => {
    const definition = await claimManagementRevision(tx, input);
    if (definition.definitionRevision !== input.definitionRevision) {
      throw new ApplicationError('CONFLICT', 'The automation changed during validation. Retry.');
    }
    const project = await tx.project.findUniqueOrThrow({ where: { id: definition.projectId } });
    if (project.isArchived) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active project.');
    }
    if (
      project.githubOwner !== input.projectSource.githubOwner ||
      project.githubRepo !== input.projectSource.githubRepo
    ) {
      throw new ApplicationError('CONFLICT', 'The project sources changed. Retry.');
    }
    const { supported, unsupportedIds } = await loadSupported(
      tx,
      definition.id,
      input.triggerIds,
      input.slackSources
    );
    await tx.agentDefinition.update({
      where: { id: definition.id },
      data: {
        isEnabled: true,
        managementRevision: { increment: 1 },
        validatedIntent: {
          version: 1,
          definitionRevision: definition.definitionRevision,
          validatedAt: now.toISOString(),
          execution: input.execution,
        },
      },
    });
    await pauseTriggers(tx, { id: { in: unsupportedIds }, activationState: { not: 'PAUSED' } });
    // Unsupported triggers report their capability reason, not an old activation failure.
    await tx.agentTrigger.updateMany({
      where: { id: { in: unsupportedIds } },
      data: { pausedReasonCode: null },
    });
    return await startSupported(tx, supported, {
      ...input,
      definitionRevision: definition.definitionRevision,
      now,
      expiry,
    });
  });
}

/** Starts each supported trigger that is not already listening; returns the GitHub ones to advance. */
async function startSupported(
  tx: Tx,
  supported: AgentTrigger[],
  input: BeginActivationInput & { now: Date; expiry: ActivationExpiry }
) {
  const starting: StartingTrigger[] = [];
  for (const trigger of supported) {
    if (trigger.activationState === 'ACTIVE' && trigger.isEnabled) {
      continue;
    }
    const slack = input.slackSources.find((source) => source.connectionId === trigger.connectionId);
    if (trigger.type === 'SLACK_MESSAGE' && slack) {
      // Slack needs no baseline: each channel's test message becomes its boundary.
      await startSlackTrigger(tx, trigger, {
        definitionRevision: input.definitionRevision,
        source: slack,
        sourceNames: input.sourceNames,
        expiresAt: new Date(input.now.getTime() + input.expiry.slackMs),
      });
      continue;
    }
    const expiresAt = new Date(input.now.getTime() + input.expiry.githubMs);
    const started = await startTrigger(tx, trigger, input.definitionRevision, expiresAt);
    if (started) {
      starting.push(started);
    }
  }
  return starting;
}

async function listStarting(): Promise<StartingTrigger[]> {
  // A plain read: each completion step rechecks its generation under the ledger lock.
  const rows = await prisma.agentTrigger.findMany({
    where: { activationState: 'STARTING', type: 'GITHUB_ISSUE', connectionId: { not: null } },
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

async function recordBaseline(trigger: StartingTrigger, baselineId: string) {
  await ledgerTransaction(async (tx) => {
    const row = await tx.agentTrigger.findUnique({ where: { id: trigger.triggerId } });
    const pending = agentGithubPendingActivationSchema.safeParse(row?.pendingActivation);
    if (
      row?.activationState !== 'STARTING' ||
      row.activationGeneration !== trigger.generation ||
      !pending.success ||
      pending.data.baselineId !== null
    ) {
      return;
    }
    await tx.agentTrigger.update({
      where: { id: row.id },
      data: { pendingActivation: { ...pending.data, baselineId } },
    });
  });
}

/** A failed preparation pauses only the generation that requested it. */
async function failStarting(trigger: StartingTrigger) {
  await ledgerTransaction(async (tx) => {
    const row = await tx.agentTrigger.findUnique({
      where: { id: trigger.triggerId },
      include: runtimeTriggerInclude,
    });
    if (!row) {
      return;
    }
    await failStartingInTransaction(
      tx,
      trigger,
      activationSourceHealth(row) === 'RECOVERY_REQUIRED'
        ? 'SOURCE_RECOVERY_REQUIRED'
        : 'SOURCE_ERROR'
    );
  });
}

type PendingCheck =
  | { pending: AgentGithubPendingActivation }
  | { pause: AgentPausedReasonCode | null };
/** Why this STARTING generation can no longer complete, if anything. */
function checkPending(row: RuntimeTrigger, now: Date): PendingCheck {
  const parsed = agentGithubPendingActivationSchema.safeParse(row.pendingActivation);
  if (
    !parsed.success ||
    parsed.data.activationGeneration !== row.activationGeneration ||
    Date.parse(parsed.data.expiresAt) <= now.getTime()
  ) {
    return { pause: 'ACTIVATION_EXPIRED' };
  }
  const health = activationSourceHealth(row);
  if (health === 'RECOVERY_REQUIRED') {
    return { pause: 'SOURCE_RECOVERY_REQUIRED' };
  }
  if (
    health === 'INVALID' ||
    !(row.connection?.isEnabled && row.connection.provider === 'GITHUB')
  ) {
    return { pause: 'SOURCE_ERROR' };
  }
  return permitsPending(row, parsed.data) ? { pending: parsed.data } : { pause: null };
}

/**
 * Completes one STARTING generation in a single transaction: its baseline must
 * have resolved, and the definition, trigger revision, connection and project
 * must still permit it. Anything else waits, or returns the trigger to PAUSED.
 */
async function activate(trigger: StartingTrigger, now: Date): Promise<ActivationOutcome> {
  return await ledgerTransaction(async (tx) => {
    const row = await tx.agentTrigger.findUnique({
      where: { id: trigger.triggerId },
      include: runtimeTriggerInclude,
    });
    if (row?.activationState !== 'STARTING' || row.activationGeneration !== trigger.generation) {
      return 'GONE';
    }
    const checked = checkPending(row, now);
    if ('pause' in checked) {
      await failStartingInTransaction(tx, trigger, checked.pause);
      return 'PAUSED';
    }
    const { pending } = checked;
    if (pending.baselineId === null) {
      return 'NEEDS_BASELINE';
    }
    const baseline = await tx.agentSourceBaseline.findFirst({
      where: { id: pending.baselineId, connectionId: pending.connectionId },
    });
    if (baseline?.sourceOrder === null) {
      return 'WAITING';
    }
    const boundary = agentActivationBoundarySchema.safeParse(
      baseline
        ? {
            provider: 'GITHUB',
            headEventId: baseline.headEventId,
            sourceOrder: baseline.sourceOrder,
          }
        : null
    );
    if (!boundary.success) {
      await failStartingInTransaction(tx, trigger, 'SOURCE_ERROR');
      return 'PAUSED';
    }
    await tx.agentTrigger.update({
      where: { id: row.id },
      data: {
        isEnabled: true,
        activationState: 'ACTIVE',
        activationBoundary: boundary.data,
        pendingActivation: Prisma.DbNull,
        pausedReasonCode: null,
      },
    });
    return 'ACTIVATED';
  });
}

/** Explicit Pause: claimed runs finish; everything unclaimed is cancelled. */
async function pause(input: AgentActivationInput) {
  return await ledgerTransaction(async (tx) => {
    const definition = await claimManagementRevision(tx, input);
    await tx.agentDefinition.update({
      where: { id: definition.id },
      data: { isEnabled: false, managementRevision: { increment: 1 } },
    });
    return await pauseTriggers(tx, { agentDefinitionId: definition.id });
  });
}

export const agentActivationAccessor = {
  begin,
  listStarting,
  recordBaseline,
  failStarting,
  activate,
  pause,
};
