import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { eventAgentExecutionSchema, type EventSessionCreation } from '@/shared/event-agent-launch';
import type { Prisma } from '@prisma-gen/client';
import { agentSessionLaunchOriginAccessor } from './agent-session-launch-origin.accessor';

const workspaceIntentSchema = z.object({ runId: z.string(), reservedSessionId: z.string() });
/** Called only inside the session owner's write transaction. */
export async function findEventSessionForCreation(
  tx: Prisma.TransactionClient,
  input: EventSessionCreation
) {
  const origin = await agentSessionLaunchOriginAccessor.find(tx, input);
  if (origin) {
    if (
      origin.runId !== input.runId ||
      origin.sessionId !== input.id ||
      origin.workspaceId !== input.workspaceId
    ) {
      throw new ApplicationError('CONFLICT', 'Event session ownership mismatch');
    }
    if (!isDeepStrictEqual(eventAgentExecutionSchema.parse(origin.execution), input.execution)) {
      throw new ApplicationError('CONFLICT', 'Event session creation intent mismatch');
    }
  }
  const existing = await tx.agentSession.findUnique({ where: { id: input.id } });
  if (origin && !existing) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Event session was deleted');
  }
  if (
    existing &&
    (!origin ||
      existing.workspaceId !== input.workspaceId ||
      existing.codexAccountId !== input.execution.codexAccountId ||
      existing.workflow !== 'event-agent' ||
      existing.provider !== input.execution.provider)
  ) {
    throw new ApplicationError('CONFLICT', 'Event session ownership mismatch');
  }
  const projectId = await assertEventWorkspaceOwnership(tx, input);
  if (!origin) {
    await assertFrozenRunBinding(tx, input, projectId);
  }
  return existing;
}

async function assertEventWorkspaceOwnership(
  tx: Prisma.TransactionClient,
  input: EventSessionCreation
) {
  const workspace = await tx.workspace.findUnique({
    where: { id: input.workspaceId },
    include: { project: true },
  });
  if (!workspace) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Event workspace was deleted');
  }
  if (
    workspace.status === 'ARCHIVING' ||
    workspace.status === 'ARCHIVED' ||
    workspace.project.isArchived
  ) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Event workspace or project is archived');
  }
  const workspaceOrigin = await tx.workspaceLaunchOrigin.findUnique({
    where: { runId: input.runId },
  });
  const intent = workspaceIntentSchema.safeParse(workspace.creationMetadata);
  if (
    workspace.creationSource !== 'EVENT_AGENT' ||
    workspaceOrigin?.workspaceId !== input.workspaceId ||
    workspaceOrigin.projectId !== workspace.projectId ||
    !intent.success ||
    intent.data.runId !== input.runId ||
    intent.data.reservedSessionId !== input.id
  ) {
    throw new ApplicationError('CONFLICT', 'Event workspace/session ownership mismatch');
  }
  return workspace.projectId;
}

/** A read-only relational integrity check; AgentRun's writer remains agent-definition. */
async function assertFrozenRunBinding(
  tx: Prisma.TransactionClient,
  input: EventSessionCreation,
  projectId: string
) {
  const run = await tx.agentRun.findUnique({
    where: { id: input.runId },
    select: {
      reservedWorkspaceId: true,
      reservedSessionId: true,
      effectiveExecution: true,
      agentDefinition: { select: { projectId: true } },
    },
  });
  const binding = eventAgentExecutionSchema.safeParse(run?.effectiveExecution);
  if (
    !run ||
    run.reservedWorkspaceId !== input.workspaceId ||
    run.reservedSessionId !== input.id ||
    run.agentDefinition.projectId !== projectId ||
    !binding.success ||
    !isDeepStrictEqual(binding.data, input.execution)
  ) {
    throw new ApplicationError('CONFLICT', 'Event session does not match the frozen run binding');
  }
}
