import { z } from 'zod';
import { agentManagementHistoryAccessor } from '@/backend/services/agent-definition/resources/agent-management-history.accessor';
import { agentManagementAccessor } from '@/backend/services/agent-definition/resources/agent-management.accessor';
import { agentRunPageSchema, agentEvaluationPageSchema } from '@/shared/agent-history';
import {
  agentHistoryInputSchema,
  agentManagementIdSchema,
  agentNavigationSummarySchema,
  savedAgentSpecificationSchema,
} from '@/shared/agent-management';
import {
  agentGetInputSchema,
  agentListInputSchema,
  agentListPageSchema,
  agentSavedUpdateSchema,
  agentSourceValidationSchema,
} from '@/shared/agent-management';
import { publicReason, runHistoryProjection } from './agent-history-projection';
import {
  managementProjection,
  managementSummary,
  nextManagementCursor,
  readManagementCursor,
} from './agent-management-projection';

export class AgentManagementService {
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
