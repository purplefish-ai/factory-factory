import type { z } from 'zod';
import { prisma } from '@/backend/db';
import {
  canResumePRMonitoring,
  isPRMonitoringRecipient,
  PR_DEDICATED_WORKFLOW,
  prDeliveryModeSchema,
  type PRDeliveryMode,
  type PRPauseReason,
} from '@/shared/pr-monitoring';
import { prMonitoringBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type { Prisma, WorkspacePRMonitoring } from '@prisma-gen/client';
import { workspacePrDeliveryAccessor } from './workspace-pr-delivery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import {
  findPRIdsWithoutObservation,
  withObservationPresence,
} from './workspace-pr-observation-presence';

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

/**
 * A change of destination (enablement, mode or recipient) cancels the unclaimed
 * facts queued for the old one. Whenever monitoring stays or turns on, it also
 * renews the event epoch, whose first observation states every fact that still
 * holds for the new destination; so no unclaimed fact outlives its epoch.
 */
function bindingTransition(input: PRBindingInput, config: WorkspacePRMonitoring) {
  const effective = resolveBinding(input, config);
  const { deliveryMode, recipientSessionId } = effective;
  const modeChanged = config.deliveryMode !== deliveryMode;
  const recipientChanged = config.recipientSessionId !== recipientSessionId;
  const bindingChanged = config.enabled !== input.enabled || recipientChanged || modeChanged;
  const shouldResume = input.resume === true && canResumePRMonitoring(config.deliveryPauseReason);
  const renewEpoch = modeChanged || (input.enabled && (!config.enabled || recipientChanged));
  const data: Prisma.WorkspacePRMonitoringUncheckedUpdateManyInput = {
    enabled: input.enabled,
    ...(shouldResume ? { deliveryPauseReason: null } : {}),
    recipientSessionId,
    deliveryMode,
    bindingRevision: { increment: 1 },
    ...(renewEpoch ? { eventEpoch: { increment: 1 } } : {}),
  };
  return { effective, bindingChanged, shouldResume, data };
}

async function updateBindingEvents(
  tx: Prisma.TransactionClient,
  transition: ReturnType<typeof bindingTransition>
) {
  const { effective, bindingChanged, shouldResume } = transition;
  if (bindingChanged) {
    await workspacePrEventAccessor.cancelInTransaction(tx, effective.workspaceId);
  }
  if (shouldResume) {
    await workspacePrDeliveryAccessor.renewRetryAllowance(tx, effective.workspaceId);
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
        await updateBindingEvents(tx, transition);
      }
      return {
        applied: result.count === 1,
        bindingRevision: config.bindingRevision + result.count,
      };
    });
  }
  pause(sessionId: string, reason: PRPauseReason) {
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
          await workspacePrDeliveryAccessor.renewRetryAllowance(tx, config.workspaceId);
        }
      });
    }
  }
  pauseWorkspace(
    workspaceId: string,
    reason: PRPauseReason | 'LEGACY_FIXER',
    expectedBindingRevision: number
  ) {
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
  /**
   * Rows legacy fixer retirement can change: retained (or corrupt) legacy IDs,
   * a LEGACY_FIXER fence to clear, or `ratchet` session rows (any status) to retire. Every
   * other row is a no-op for the cutover, so startup skips it in SQL.
   */
  listLegacyRetirementCandidates() {
    return prisma.workspacePRMonitoring
      .findMany({
        where: {
          OR: [
            { NOT: { legacySessionIds: { equals: [] } } },
            { deliveryPauseReason: { startsWith: 'LEGACY_FIXER' } },
            { workspace: { agentSessions: { some: { workflow: 'ratchet' } } } },
          ],
        },
      })
      .then((rows) => rows.map(normalizeConfig));
  }
  /**
   * Enabled monitoring configs with their attached PRs, for the PR watcher. The
   * read loads no workspace columns and no PR observation; each PR carries the
   * `hasObservation` flag the polling policy reads instead.
   */
  listEnabled() {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.workspacePRMonitoring.findMany({
        where: { enabled: true, workspace: { status: 'READY' } },
        include: {
          workspace: {
            select: {
              prs: { where: { detachedAt: null }, omit: { observation: true } },
            },
          },
        },
      });
      const missing = await findPRIdsWithoutObservation(
        tx,
        rows.flatMap(({ workspace }) => workspace.prs.map(({ id }) => id))
      );
      return rows.map(({ workspace, ...config }) =>
        normalizeConfig({
          ...config,
          workspace: { prs: withObservationPresence(workspace.prs, missing) },
        })
      );
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
