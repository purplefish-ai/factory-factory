import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentManagementHistoryAccessor } from '@/backend/services/agent-definition/resources/agent-management-history.accessor';
import { agentManagementAccessor } from '@/backend/services/agent-definition/resources/agent-management.accessor';
import { agentSourceAccessor } from '@/backend/services/agent-definition/resources/agent-source.accessor';
import { agentRunPageSchema, agentEvaluationPageSchema } from '@/shared/agent-history';
import {
  agentHistoryInputSchema,
  agentManagementIdSchema,
  agentNavigationSummarySchema,
  savedAgentSpecificationSchema,
} from '@/shared/agent-management';
import {
  agentActivationInputSchema,
  agentDeleteResultSchema,
  agentGetInputSchema,
  agentListInputSchema,
  agentListPageSchema,
  agentSavedUpdateSchema,
  agentSourceResetInputSchema,
  agentSourceResetResultSchema,
  agentSourceValidationSchema,
} from '@/shared/agent-management';
import { agentRecoveryTargetInputSchema } from '@/shared/event-agent-recovery';
import { publicReason, runHistoryProjection } from './agent-history-projection';
import {
  managementProjection,
  managementSummary,
  nextManagementCursor,
  readManagementCursor,
} from './agent-management-projection';
import { recoveryTargetProjection } from './agent-recovery-target';

export class AgentManagementService {
  async recoveryTarget(input: unknown) {
    const parsed = agentRecoveryTargetInputSchema.parse(input);
    return recoveryTargetProjection(
      parsed,
      await agentManagementHistoryAccessor.recoveryTarget(parsed)
    );
  }
  async assertRecoveryScope(input: unknown) {
    const parsed = agentRecoveryTargetInputSchema.parse(input);
    if (!(await agentManagementHistoryAccessor.recoveryTarget(parsed))) {
      throw new ApplicationError('NOT_FOUND', 'Event run not found.');
    }
  }
  /** Pauses every trigger on the source, cancels queued runs and lifts the recovery fence. */
  async resetSource(input: unknown) {
    const parsed = agentSourceResetInputSchema.parse(input);
    return agentSourceResetResultSchema.parse(
      await agentSourceAccessor.resetSource(parsed.projectId, parsed.connectionId)
    );
  }
  /** Trusted-local only: refused while a claimed run is unfinished; workspaces stay. */
  async delete(input: unknown) {
    return agentDeleteResultSchema.parse(
      await agentManagementAccessor.delete(agentActivationInputSchema.parse(input))
    );
  }
  checkSources(projectId: string, specification: unknown, evidence: unknown) {
    return agentManagementAccessor.checkSources(
      agentManagementIdSchema.parse(projectId),
      savedAgentSpecificationSchema.parse(specification),
      agentSourceValidationSchema.parse(evidence)
    );
  }
  async runs(input: unknown) {
    const parsed = agentHistoryInputSchema.parse(input);
    const scope = { projectId: parsed.projectId, agentId: parsed.agentId, kind: 'runs' as const };
    const rows = await agentManagementHistoryAccessor.runs(
      parsed,
      readManagementCursor(parsed.cursor, scope)
    );
    return agentRunPageSchema.parse({
      items: rows.slice(0, parsed.limit).map(runHistoryProjection),
      nextCursor: nextManagementCursor(rows, parsed.limit, scope),
    });
  }
  async evaluations(input: unknown) {
    const parsed = agentHistoryInputSchema.parse(input);
    const scope = {
      projectId: parsed.projectId,
      agentId: parsed.agentId,
      kind: 'evaluations' as const,
    };
    const rows = await agentManagementHistoryAccessor.evaluations(
      parsed,
      readManagementCursor(parsed.cursor, scope)
    );
    return agentEvaluationPageSchema.parse({
      items: rows.slice(0, parsed.limit).map((row) => ({
        ...row,
        reasonCode: publicReason(row.reasonCode),
        explanation: 'Recorded event evaluation.',
        createdAt: row.createdAt.toISOString(),
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
      })),
      nextCursor: nextManagementCursor(rows, parsed.limit, scope),
    });
  }
  async navigationSummary(input: unknown) {
    const parsed = z.strictObject({ projectId: agentManagementIdSchema }).parse(input);
    return agentNavigationSummarySchema.parse(
      await agentManagementHistoryAccessor.navigationSummary(parsed.projectId)
    );
  }
  async originRun(input: unknown) {
    const parsed = z
      .strictObject({
        projectId: agentManagementIdSchema,
        workspaceId: agentManagementIdSchema,
        runId: agentManagementIdSchema,
      })
      .parse(input);
    const run = await agentManagementHistoryAccessor.originRun(parsed);
    return run ? runHistoryProjection(run) : null;
  }

  async get(input: unknown) {
    const parsed = agentGetInputSchema.parse(input);
    return managementProjection(
      await agentManagementAccessor.get(
        parsed,
        readManagementCursor(parsed.retainedCursor, { ...parsed, kind: 'retained' })
      )
    );
  }
  async updateSaved(input: unknown, evidence: unknown) {
    return managementProjection(
      await agentManagementAccessor.updateSaved(
        agentSavedUpdateSchema.parse(input),
        agentSourceValidationSchema.parse(evidence)
      )
    );
  }
  async list(input: unknown) {
    const parsed = agentListInputSchema.parse(input);
    const scope = { projectId: parsed.projectId, kind: 'list' as const };
    const rows = await agentManagementAccessor.list(
      parsed.projectId,
      parsed.limit,
      readManagementCursor(parsed.cursor, scope)
    );
    return agentListPageSchema.parse({
      items: rows.slice(0, parsed.limit).map(managementSummary),
      nextCursor: nextManagementCursor(rows, parsed.limit, scope),
    });
  }
}
