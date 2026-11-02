import { z } from 'zod';
import { agentRunResultSchema } from '@/shared/agent-runtime';
import { initialAttemptSchema } from '@/shared/event-agent-delivery';
import type { Prisma } from '@prisma-gen/client';
import { launchConflict } from './agent-launch.accessor';
import { mergeRunResults } from './agent-run-result';

const captureSchema = z.strictObject({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  originRunId: z.string().min(1).nullable(),
  result: agentRunResultSchema,
});

export const agentRunResultsAccessor = {
  /** Joins the workspace owner's write-locked deletion transaction; never settles work. */
  async captureWorkspace(tx: Prisma.TransactionClient, input: z.infer<typeof captureSchema>) {
    const capture = captureSchema.parse(input);
    const runs = await tx.agentRun.findMany({
      where: {
        OR: [
          { reservedWorkspaceId: capture.workspaceId },
          { workspaceId: capture.workspaceId },
          ...(capture.originRunId ? [{ id: capture.originRunId }] : []),
        ],
      },
      include: { agentDefinition: { select: { projectId: true } }, initialDelivery: true },
      take: 2,
    });
    if (runs.length > 1) {
      launchConflict();
    }
    const run = runs[0];
    if (!run) {
      return;
    }
    if (
      run.reservedWorkspaceId !== capture.workspaceId ||
      (run.workspaceId !== null && run.workspaceId !== capture.workspaceId) ||
      run.agentDefinition.projectId !== capture.projectId ||
      (capture.originRunId !== null && capture.originRunId !== run.id)
    ) {
      launchConflict();
    }
    // A lookup by workspace alone can miss an origin moved away from this run's reservation.
    const origin = await tx.workspaceLaunchOrigin.findUnique({ where: { runId: run.id } });
    if (
      origin &&
      (origin.workspaceId !== capture.workspaceId || origin.projectId !== capture.projectId)
    ) {
      launchConflict();
    }
    if (run.status === 'RUNNING') {
      initialAttemptSchema.parse({
        runId: run.id,
        workerGeneration: run.workerGeneration,
        attemptGeneration: run.attemptGeneration,
        sessionId: run.reservedSessionId,
        messageId: run.initialDelivery?.messageId,
        sendAttemptId: run.initialDelivery?.sendAttemptId,
      });
      if (run.initialDelivery?.attemptGeneration !== run.attemptGeneration) {
        launchConflict();
      }
    }
    const result = mergeRunResults(run.result, capture.result);
    const written = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        reservedWorkspaceId: capture.workspaceId,
        workspaceId: run.workspaceId,
        status: run.status,
        workerGeneration: run.workerGeneration,
        attemptGeneration: run.attemptGeneration,
      },
      data: { result },
    });
    if (written.count !== 1) {
      launchConflict();
    }
  },
};
