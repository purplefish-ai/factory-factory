import type { Prisma } from '@prisma-gen/client';
import type { z } from 'zod';
import { prisma } from '@/backend/db';
import { isPRMonitoringRecipient } from '@/shared/pr-monitoring';
import { prMonitoringBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

export interface PRBindingInput {
  workspaceId: string;
  recipientSessionId: string | null;
  enabled: boolean;
  expectedBindingRevision: number;
  replyToPrComments?: boolean;
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
  if (!(input.enabled && input.recipientSessionId) || input.replyToPrComments === undefined) {
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
  get(workspaceId: string) {
    return prisma.workspacePRMonitoring.findUnique({ where: { workspaceId } });
  }
  setBinding(input: PRBindingInput) {
    return prisma.$transaction(async (tx) => {
      await validateRecipient(tx, input);
      const config = await tx.workspacePRMonitoring.upsert({
        where: { workspaceId: input.workspaceId },
        create: { workspaceId: input.workspaceId },
        update: {},
      });
      if (config.bindingRevision !== input.expectedBindingRevision) {
        return { applied: false, bindingRevision: config.bindingRevision };
      }
      if (
        config.enabled === input.enabled &&
        config.recipientSessionId === input.recipientSessionId
      ) {
        await insertEnableControl(tx, input, config.bindingRevision);
        return { applied: true, bindingRevision: config.bindingRevision };
      }
      const result = await tx.workspacePRMonitoring.updateMany({
        where: { workspaceId: input.workspaceId, bindingRevision: input.expectedBindingRevision },
        data: {
          enabled: input.enabled,
          recipientSessionId: input.recipientSessionId,
          bindingRevision: { increment: 1 },
          ...(input.enabled &&
          (!config.enabled || config.recipientSessionId !== input.recipientSessionId)
            ? { eventEpoch: { increment: 1 } }
            : {}),
        },
      });
      if (result.count) {
        await workspacePrEventAccessor.cancelInTransaction(tx, input.workspaceId);
        await insertEnableControl(tx, input, config.bindingRevision + 1);
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
        where: { recipientSessionId: sessionId },
      });
      let count = 0;
      for (const config of configs) {
        const paused = await tx.workspacePRMonitoring.updateMany({
          where: {
            workspaceId: config.workspaceId,
            recipientSessionId: sessionId,
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
  async resume(sessionId: string) {
    const configs = await prisma.workspacePRMonitoring.findMany({
      where: {
        recipientSessionId: sessionId,
        deliveryPauseReason: {
          in: [
            'USER_STOPPED',
            'SESSION_FAILED',
            'RESUME_FAILED',
            'DELIVERY_FAILED',
            'RECEIPT_UNAVAILABLE',
          ],
        },
      },
    });
    for (const config of configs) {
      await prisma.$transaction(async (tx) => {
        const resumed = await tx.workspacePRMonitoring.updateMany({
          where: {
            workspaceId: config.workspaceId,
            recipientSessionId: sessionId,
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
    return prisma.workspacePRMonitoring.findMany();
  }
  listEnabled() {
    return prisma.workspacePRMonitoring.findMany({
      where: { enabled: true, workspace: { status: 'READY' } },
      include: { workspace: { include: { project: true, prs: { where: { detachedAt: null } } } } },
    });
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
