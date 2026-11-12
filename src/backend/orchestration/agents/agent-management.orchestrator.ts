import { ApplicationError } from '@/backend/lib/application-error';
import {
  triggerCapability,
  type AgentManagementService,
} from '@/backend/services/agent-definition';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import type { workspaceDataService } from '@/backend/services/workspace';
import { agentRunPageSchema, agentWorkspaceOriginSchema } from '@/shared/agent-history';
import {
  agentActivationInputSchema,
  agentSavedUpdateSchema,
  type SavedAgentSpecification,
  type AgentSourceValidation,
} from '@/shared/agent-management';
import {
  agentDraftValidationInputSchema,
  agentDraftValidationSchema,
  agentProjectSourcesInputSchema,
} from '@/shared/agent-validation';
import {
  agentRecoveryContextSchema,
  agentRecoveryInputSchema,
  agentRecoveryInspectionSchema,
  agentRecoveryResultSchema,
} from '@/shared/event-agent-recovery';
import {
  validateAgentExecution,
  type AgentNativeValidationServices,
} from './agent-native-validation';
import type { createAgentRuntime } from './agent-runtime.orchestrator';
import {
  discoverProjectAgentSources,
  resolveProjectAgentSources,
  type AgentSourceProject,
  type AgentSourceServices,
} from './agent-sources.orchestrator';

type Services = AgentSourceServices &
  AgentNativeValidationServices & {
    projectManagementService: { findById(id: string): Promise<AgentSourceProject | null> };
    agentManagementService: AgentManagementService;
    agentRuntime?: Pick<ReturnType<typeof createAgentRuntime>, 'recovery' | 'activation'>;
    workspaceDataService: Pick<typeof workspaceDataService, 'readEventOrigin'>;
  };
async function activeProject(projectId: string, services: Services) {
  const project = await services.projectManagementService.findById(projectId);
  if (!project) {
    throw new ApplicationError('NOT_FOUND', 'Project not found.');
  }
  if (project.isArchived) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active project.');
  }
  return project;
}
async function assertProjectCurrent(project: AgentSourceProject, services: Services) {
  const current = await activeProject(project.id, services);
  if (current.githubOwner !== project.githubOwner || current.githubRepo !== project.githubRepo) {
    throw new ApplicationError('CONFLICT', 'The project sources changed. Retry validation.');
  }
}
async function validateTriggers(
  project: AgentSourceProject,
  specification: SavedAgentSpecification,
  services: Services
) {
  const results = [];
  const verified: {
    index: number;
    specification: SavedAgentSpecification;
    evidence: AgentSourceValidation;
  }[] = [];
  for (const [index, trigger] of specification.triggers.entries()) {
    let result = triggerCapability(trigger);
    try {
      const selected = { ...specification, triggers: [trigger] };
      const evidence = await resolveProjectAgentSources(project, selected, services);
      verified.push({ index, specification: selected, evidence });
      result = triggerCapability(trigger, true);
    } catch {
      if (result.reasonCode === 'SOURCE_UNVERIFIED') {
        result = {
          status: 'UNAVAILABLE',
          reasonCode: 'SOURCE_UNAVAILABLE',
          explanation: 'The selected source could not be verified.',
        };
      }
    }
    results.push({ index, triggerId: trigger.id ?? null, capability: result });
  }
  return { results, verified };
}
async function recoveryScope(
  input: { projectId: string; agentId: string; claim: { runId: string } },
  services: Services
) {
  await services.agentManagementService.assertRecoveryScope({
    projectId: input.projectId,
    agentId: input.agentId,
    runId: input.claim.runId,
  });
  const recovery = services.agentRuntime?.recovery;
  if (!recovery) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Event recovery is unavailable.');
  }
  return recovery;
}
function activationRuntime(services: Services) {
  const activation = services.agentRuntime?.activation;
  if (!activation) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Event activation is unavailable.');
  }
  return activation;
}
/** The server-side validation behind both the draft preview and Enable. */
async function validateSpecification(
  project: AgentSourceProject,
  specification: SavedAgentSpecification,
  services: Services
) {
  const validation = await validateTriggers(project, specification, services);
  const execution = await validateAgentExecution(specification.executionConfig, services);
  await assertProjectCurrent(project, services);
  for (const source of validation.verified) {
    try {
      await services.agentManagementService.checkSources(
        project.id,
        source.specification,
        source.evidence
      );
    } catch {
      const result = validation.results[source.index];
      if (!result) {
        throw new Error('Missing validation result');
      }
      result.capability = {
        status: 'UNAVAILABLE',
        reasonCode: 'SOURCE_UNAVAILABLE',
        explanation: 'The selected source changed during validation.',
      };
    }
  }
  await assertProjectCurrent(project, services);
  return { triggers: validation.results, execution };
}
export function createAgentManagement(getServices: () => Services) {
  return {
    async inspectRun(input: unknown) {
      const { agentId, ...context } = agentRecoveryContextSchema.parse(input);
      const recovery = await recoveryScope({ ...context, agentId }, getServices());
      try {
        const inspected = await recovery.inspectRun(context);
        return agentRecoveryInspectionSchema.parse({
          projectId: context.projectId,
          agentId,
          runId: context.claim.runId,
          context,
          run: {
            status: 'RUNNING',
            launchPhase: inspected.run.phase,
            deliveryState: inspected.run.delivery.state,
            preparationState: inspected.run.preparation?.state ?? null,
          },
          blocked: inspected.blocked,
          retryBlocked: inspected.retryBlocked,
          retryResourcesAvailable: inspected.retryResourcesAvailable,
          proofAvailable: inspected.proofAvailable,
          delivery: inspected.delivery,
        });
      } catch {
        throw new ApplicationError('CONFLICT', 'Event recovery context is unavailable or changed.');
      }
    },
    async resolveAmbiguousRun(input: unknown) {
      const { agentId, ...context } = agentRecoveryInputSchema.parse(input);
      const recovery = await recoveryScope({ ...context, agentId }, getServices());
      try {
        return agentRecoveryResultSchema.parse(await recovery.resolveAmbiguousRun(context));
      } catch {
        throw new ApplicationError('CONFLICT', 'Event recovery context is unavailable or changed.');
      }
    },
    async updateSaved(input: unknown) {
      const parsed = agentSavedUpdateSchema.parse(input);
      const services = getServices();
      // Check ownership before performing any external source lookup.
      await services.agentManagementService.get({
        projectId: parsed.projectId,
        agentId: parsed.agentId,
      });
      const project = await activeProject(parsed.projectId, services);
      const evidence = await resolveProjectAgentSources(project, parsed.specification, services);
      return services.agentManagementService.updateSaved(parsed, evidence);
    },
    async projectSources(input: unknown) {
      const parsed = agentProjectSourcesInputSchema.parse(input);
      const services = getServices();
      const project = await activeProject(parsed.projectId, services);
      const result = await discoverProjectAgentSources(project, parsed, services);
      await assertProjectCurrent(project, services);
      return result;
    },
    async validateDraft(input: unknown) {
      const parsed = agentDraftValidationInputSchema.parse(input);
      const services = getServices();
      const project = await activeProject(parsed.projectId, services);
      return agentDraftValidationSchema.parse(
        await validateSpecification(project, parsed.specification, services)
      );
    },
    /** Validates exactly what the draft preview shows, then starts every supported trigger. */
    async enable(input: unknown) {
      const parsed = agentActivationInputSchema.parse(input);
      const services = getServices();
      const owner = { projectId: parsed.projectId, agentId: parsed.agentId };
      const agent = await services.agentManagementService.get(owner);
      if (agent.managementRevision !== parsed.expectedManagementRevision) {
        throw new ApplicationError('CONFLICT', 'This automation changed. Reload it and try again.');
      }
      if (!agent.specification) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Save the complete configuration before enabling this automation.'
        );
      }
      const activation = activationRuntime(services);
      const project = await activeProject(parsed.projectId, services);
      const validation = await validateSpecification(project, agent.specification, services);
      if (validation.execution.status !== 'VALIDATED') {
        throw new ApplicationError('PRECONDITION_FAILED', validation.execution.explanation);
      }
      const triggerIds = validation.triggers.flatMap((result) =>
        result.capability.status === 'SUPPORTED' && result.triggerId ? [result.triggerId] : []
      );
      if (!triggerIds.length) {
        const reasons = new Set(validation.triggers.map((result) => result.capability.explanation));
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          ['No trigger in this automation can start.', ...reasons].join(' ')
        );
      }
      await activation.begin(
        {
          ...parsed,
          definitionRevision: agent.definitionRevision,
          projectSource: { githubOwner: project.githubOwner, githubRepo: project.githubRepo },
          execution: validation.execution.intent,
          triggerIds,
        },
        AbortSignal.timeout(SERVICE_TIMEOUT_MS.agentActivationBaseline)
      );
      return services.agentManagementService.get(owner);
    },
    /** Pauses every trigger; claimed runs finish and unclaimed runs are cancelled. */
    async pause(input: unknown) {
      const parsed = agentActivationInputSchema.parse(input);
      const services = getServices();
      await activationRuntime(services).pause(parsed);
      return services.agentManagementService.get({
        projectId: parsed.projectId,
        agentId: parsed.agentId,
      });
    },
    async runs(input: { projectId: string; agentId: string; limit?: number; cursor?: string }) {
      const services = getServices();
      const page = await services.agentManagementService.runs(input);
      for (const run of page.items) {
        if (!run.reservedWorkspaceId) {
          continue;
        }
        const origin = await services.workspaceDataService.readEventOrigin({
          projectId: input.projectId,
          workspaceId: run.reservedWorkspaceId,
        });
        if ((!origin && run.workspaceId) || (origin && origin.runId !== run.id)) {
          throw new ApplicationError('NOT_FOUND', 'Event origin does not match the run.');
        }
        if (origin) {
          run.workspaceState = origin.workspaceState;
        }
      }
      return agentRunPageSchema.parse(page);
    },
    async workspaceOrigin(input: { projectId: string; workspaceId: string }) {
      const services = getServices();
      const origin = await services.workspaceDataService.readEventOrigin(input);
      const run = origin
        ? await services.agentManagementService.originRun({
            projectId: origin.projectId,
            workspaceId: origin.workspaceId,
            runId: origin.runId,
          })
        : null;
      if (run && origin) {
        run.workspaceState = origin.workspaceState;
      }
      return agentWorkspaceOriginSchema.parse(origin ? { origin, run } : null);
    },
  };
}
