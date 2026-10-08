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
      }
      return {
        applied: result.count === 1,
        bindingRevision: config.bindingRevision + result.count,
      };
    });
  }
  pause(sessionId: string, reason: string) {
    return prisma.workspacePRMonitoring.updateMany({
      where: {
        recipientSessionId: sessionId,
        OR: [{ deliveryPauseReason: null }, { deliveryPauseReason: { not: 'LEGACY_FIXER' } }],
      },
      data: { deliveryPauseReason: reason, bindingRevision: { increment: 1 } },
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
    return prisma.workspacePRMonitoring.updateMany({
      where: { workspaceId, bindingRevision: expectedBindingRevision },
      data: { deliveryPauseReason: reason, bindingRevision: { increment: 1 } },
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
  completeLegacyRetirement(workspaceId: string) {
    return prisma.workspacePRMonitoring.updateMany({
      where: { workspaceId, deliveryPauseReason: 'LEGACY_FIXER' },
      data: { deliveryPauseReason: null, bindingRevision: { increment: 1 } },
    });
  }
}
export const workspacePrMonitoringAccessor = new WorkspacePrMonitoringAccessor();
