import type { Prisma, WorkspacePRMonitoring } from '@prisma-gen/client';
import type { z } from 'zod';
import { prisma } from '@/backend/db';
import {
  canResumePRMonitoring,
  isPRMonitoringRecipient,
  PR_DEDICATED_WORKFLOW,
  prDeliveryModeSchema,
  type PRDeliveryMode,
} from '@/shared/pr-monitoring';
import { prMonitoringBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

export interface PRBindingInput {
  workspaceId: string;
  recipientSessionId?: string | null;
  deliveryMode?: PRDeliveryMode;
  enabled: boolean;
  expectedBindingRevision: number;
  replyToPrComments?: boolean;
  resume?: boolean;
}
async function validateRecipient(tx: Prisma.TransactionClient, input: PRBindingInput) {
  if (input.recipientSessionId) {
    const session = await tx.agentSession.findFirst({
      where: { id: input.recipientSessionId, workspaceId: input.workspaceId },
    });
    if (!(session && isPRMonitoringRecipient(session))) {
      throw new Error('Select an ordinary session in this workspace');
    }
  }
}
async function insertEnableControl(
  tx: Prisma.TransactionClient,
  input: PRBindingInput,
  bindingRevision: number
) {
  if (
    input.deliveryMode === 'DEDICATED' ||
    !(input.enabled && input.recipientSessionId) ||
    input.replyToPrComments === undefined
  ) {
    return;
  }
  await workspacePrEventAccessor.insert(tx, input.workspaceId, null, [
    {
      kind: 'MONITORING_ENABLED',
      deduplicationKey: `enabled:${bindingRevision}`,
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: input.workspaceId,
        bindingRevision,
        replyToPrComments: input.replyToPrComments,
      },
    },
  ]);
}
function resolveBinding(input: PRBindingInput, config: WorkspacePRMonitoring) {
  const deliveryMode = prDeliveryModeSchema.parse(input.deliveryMode ?? config.deliveryMode);
  const recipientSessionId =
    deliveryMode === 'DEDICATED'
      ? (input.recipientSessionId ?? config.recipientSessionId)
      : input.recipientSessionId === undefined
        ? config.recipientSessionId
        : input.recipientSessionId;
  return { ...input, deliveryMode, recipientSessionId };
}

function bindingTransition(input: PRBindingInput, config: WorkspacePRMonitoring) {
  const effective = resolveBinding(input, config);
  const { deliveryMode, recipientSessionId } = effective;
  const modeChanged = config.deliveryMode !== deliveryMode;
  const recipientChanged = config.recipientSessionId !== recipientSessionId;
  const preservePendingFacts = modeChanged && config.enabled && input.enabled;
  const cancelPendingFacts =
    config.enabled !== input.enabled || (recipientChanged && !preservePendingFacts);
  const bindingChanged = cancelPendingFacts || modeChanged;
  const shouldResume = input.resume === true && canResumePRMonitoring(config.deliveryPauseReason);
  const renewEpoch =
    modeChanged ||
    (input.enabled && (!config.enabled || config.recipientSessionId !== recipientSessionId));
  const data: Prisma.WorkspacePRMonitoringUncheckedUpdateManyInput = {
    enabled: input.enabled,
    ...(shouldResume ? { deliveryPauseReason: null } : {}),
    recipientSessionId,
    deliveryMode,
    bindingRevision: { increment: 1 },
    ...(renewEpoch ? { eventEpoch: { increment: 1 } } : {}),
  };
  return { effective, bindingChanged, cancelPendingFacts, shouldResume, data };
}

async function updateBindingEvents(
  tx: Prisma.TransactionClient,
  transition: ReturnType<typeof bindingTransition>,
  bindingRevision: number
) {
  const { effective, bindingChanged, cancelPendingFacts, shouldResume } = transition;
  if (bindingChanged) {
    if (cancelPendingFacts) {
      await workspacePrEventAccessor.cancelInTransaction(tx, effective.workspaceId);
    } else {
      await workspacePrEventAccessor.cancelUnclaimedControls(tx, effective.workspaceId);
    }
    await insertEnableControl(tx, effective, bindingRevision);
  }
  if (shouldResume) {
    await workspacePrEventAccessor.renewRetryAllowance(tx, effective.workspaceId);
  }
}

/** Only a recipient of the current destination can stop or resume monitoring. */
function recipientWhere(sessionId: string): Prisma.WorkspacePRMonitoringWhereInput {
  return {
    OR: [
      { deliveryMode: 'MAIN', recipientSessionId: sessionId },
      {
        deliveryMode: 'DEDICATED',
        workspace: {
          agentSessions: { some: { id: sessionId, workflow: PR_DEDICATED_WORKFLOW } },
          prs: { some: { detachedAt: null, dedicatedSession: { sessionId } } },
        },
      },
    ],
  };
}
function normalizeConfig<T extends { deliveryMode: string }>(config: T) {
  return { ...config, deliveryMode: prDeliveryModeSchema.parse(config.deliveryMode) };
}

class WorkspacePrMonitoringAccessor {
  async restoreBackup(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    raw: z.infer<typeof prMonitoringBackupSchema>
  ) {
    const config = prMonitoringBackupSchema.parse(raw);
    const recipient = config.recipientSessionId
      ? await tx.agentSession.findFirst({ where: { id: config.recipientSessionId, workspaceId } })
      : null;
    const valid = !!recipient && isPRMonitoringRecipient(recipient);
    const data = {
      ...config,
      recipientSessionId: valid ? recipient.id : null,
      lastCheckedAt: config.lastCheckedAt ? new Date(config.lastCheckedAt) : null,
    };
    return tx.workspacePRMonitoring.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  }
  async get(workspaceId: string) {
    const row = await prisma.workspacePRMonitoring.findUnique({ where: { workspaceId } });
    return row ? normalizeConfig(row) : null;
  }
  setBinding(input: PRBindingInput) {
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.upsert({
        where: { workspaceId: input.workspaceId },
        create: { workspaceId: input.workspaceId },
        update: {},
      });
      if (config.bindingRevision !== input.expectedBindingRevision) {
        return { applied: false, bindingRevision: config.bindingRevision };
      }
      const transition = bindingTransition(input, config);
      const { effective, bindingChanged, shouldResume, data } = transition;
      await validateRecipient(tx, effective);
      if (!(bindingChanged || shouldResume)) {
        await insertEnableControl(tx, effective, config.bindingRevision);
        return { applied: true, bindingRevision: config.bindingRevision };
      }
      const result = await tx.workspacePRMonitoring.updateMany({
        where: {
          workspaceId: input.workspaceId,
          bindingRevision: input.expectedBindingRevision,
          deliveryPauseReason: config.deliveryPauseReason,
        },
        data,
      });
      if (result.count) {
        await updateBindingEvents(tx, transition, config.bindingRevision + 1);
      }
      return {
        applied: result.count === 1,
        bindingRevision: config.bindingRevision + result.count,
      };
    });
  }
  pause(sessionId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const configs = await tx.workspacePRMonitoring.findMany({
        where: recipientWhere(sessionId),
      });
      let count = 0;
      for (const config of configs) {
        const paused = await tx.workspacePRMonitoring.updateMany({
          where: {
            workspaceId: config.workspaceId,
            ...recipientWhere(sessionId),
            bindingRevision: config.bindingRevision,
          },
          data: {
            deliveryPauseReason: config.deliveryPauseReason?.startsWith('LEGACY_FIXER')
              ? `LEGACY_FIXER_${reason}`
              : reason,
            bindingRevision: { increment: 1 },
          },
        });
        count += paused.count;
      }
      return { count };
    });
  }
  async resume(sessionId: string, isCurrent?: () => boolean) {
    if (isCurrent?.() === false) {
      return;
    }
    const configs = await prisma.workspacePRMonitoring.findMany({
      where: {
        ...recipientWhere(sessionId),
        deliveryPauseReason: { not: null },
      },
    });
    if (isCurrent?.() === false) {
      return;
    }
    for (const config of configs) {
      if (!canResumePRMonitoring(config.deliveryPauseReason)) {
        continue;
      }
      await prisma.$transaction(async (tx) => {
        if (isCurrent?.() === false) {
          return;
        }
        const resumed = await tx.workspacePRMonitoring.updateMany({
          where: {
            workspaceId: config.workspaceId,
            ...recipientWhere(sessionId),
            bindingRevision: config.bindingRevision,
            deliveryPauseReason: config.deliveryPauseReason,
          },
          data: { deliveryPauseReason: null, bindingRevision: { increment: 1 } },
        });
        if (resumed.count) {
          await workspacePrEventAccessor.renewRetryAllowance(tx, config.workspaceId);
        }
      });
    }
  }
  pauseWorkspace(workspaceId: string, reason: string, expectedBindingRevision: number) {
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.findFirst({
        where: { workspaceId, bindingRevision: expectedBindingRevision },
      });
      if (!config) {
        return { count: 0 };
      }
      const existing = config.deliveryPauseReason;
      const pauseReason =
        reason === 'LEGACY_FIXER' && existing && !existing.startsWith('LEGACY_FIXER')
          ? `LEGACY_FIXER_${existing}`
          : existing?.startsWith('LEGACY_FIXER')
            ? existing
            : reason;
      return tx.workspacePRMonitoring.updateMany({
        where: { workspaceId, bindingRevision: expectedBindingRevision },
        data: { deliveryPauseReason: pauseReason, bindingRevision: { increment: 1 } },
      });
    });
  }
  markChecked(workspaceId: string) {
    return prisma.workspacePRMonitoring.updateMany({
      where: { workspaceId },
      data: { lastCheckedAt: new Date() },
    });
  }
  listConfigs() {
    return prisma.workspacePRMonitoring.findMany().then((rows) => rows.map(normalizeConfig));
  }
  listEnabled() {
    return prisma.workspacePRMonitoring
      .findMany({
        where: { enabled: true, workspace: { status: 'READY' } },
        include: {
          workspace: { include: { project: true, prs: { where: { detachedAt: null } } } },
        },
      })
      .then((rows) => rows.map(normalizeConfig));
  }
  completeLegacyRetirement(workspaceId: string, expectedBindingRevision: number) {
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.findFirst({
        where: { workspaceId, bindingRevision: expectedBindingRevision },
      });
      if (!config?.deliveryPauseReason?.startsWith('LEGACY_FIXER')) {
        return { count: 0 };
      }
      const remainingPause =
        config.deliveryPauseReason === 'LEGACY_FIXER'
          ? null
          : config.deliveryPauseReason.slice('LEGACY_FIXER_'.length);
      return tx.workspacePRMonitoring.updateMany({
        where: {
          workspaceId,
          bindingRevision: expectedBindingRevision,
          deliveryPauseReason: config.deliveryPauseReason,
        },
        data: { deliveryPauseReason: remainingPause, bindingRevision: { increment: 1 } },
      });
    });
  }
}
export const workspacePrMonitoringAccessor = new WorkspacePrMonitoringAccessor();
