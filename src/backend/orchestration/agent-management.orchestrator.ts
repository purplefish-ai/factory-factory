import { ApplicationError } from '@/backend/lib/application-error';
import {
  triggerCapability,
  type AgentManagementService,
} from '@/backend/services/agent-definition';
import type { workspaceDataService } from '@/backend/services/workspace';
import { agentRunPageSchema, agentWorkspaceOriginSchema } from '@/shared/agent-history';
import {
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
  validateAgentExecution,
  type AgentNativeValidationServices,
} from './agent-native-validation';
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
export function createAgentManagement(getServices: () => Services) {
  return {
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
      const validation = await validateTriggers(project, parsed.specification, services);
      const execution = await validateAgentExecution(
        parsed.specification.executionConfig,
        services
      );
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
      return agentDraftValidationSchema.parse({ triggers: validation.results, execution });
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
        if (origin && origin.runId !== run.id) {
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
