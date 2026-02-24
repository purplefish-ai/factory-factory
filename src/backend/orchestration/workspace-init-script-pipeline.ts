import { startupScriptService } from '@/backend/domains/run-script';
import { sessionService } from '@/backend/domains/session';
import type { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import type { WorkspaceWithProject } from './types';

const logger = createLogger('workspace-init-script-pipeline');

export type StartupScriptPhase = 'factory_setup' | 'project_startup';

export interface StartupScriptPipelineResult {
  handled: boolean;
  phase: StartupScriptPhase | null;
  success: boolean;
}

interface StartupScriptPipelineContext {
  workspaceId: string;
  workspaceWithProject: WorkspaceWithProject;
  worktreePath: string;
  factoryConfig: Awaited<ReturnType<typeof FactoryConfigService.readConfig>>;
  getWorkspaceInitErrorMessage: () => Promise<string | null | undefined>;
}

interface StartupScriptPhaseDefinition {
  phase: StartupScriptPhase;
  shouldRun: (context: StartupScriptPipelineContext) => boolean;
  buildProjectConfig: (
    context: StartupScriptPipelineContext
  ) => StartupScriptPipelineContext['workspaceWithProject']['project'];
  logStart: (context: StartupScriptPipelineContext) => void;
  scriptFailedLogMessage: string;
  cleanupFailedLogMessage: string;
}

const scriptPhaseDefinitions: StartupScriptPhaseDefinition[] = [
  {
    phase: 'factory_setup',
    shouldRun: (context) => !!context.factoryConfig?.scripts.setup,
    buildProjectConfig: (context) => ({
      ...context.workspaceWithProject.project,
      startupScriptCommand: context.factoryConfig?.scripts.setup ?? null,
      startupScriptPath: null,
    }),
    logStart: (context) => {
      logger.info('Running setup script from factory-factory.json', {
        workspaceId: context.workspaceId,
      });
    },
    scriptFailedLogMessage: 'Setup script from factory-factory.json failed but workspace created',
    cleanupFailedLogMessage: 'Failed to stop Claude sessions after setup script failure',
  },
  {
    phase: 'project_startup',
    shouldRun: (context) =>
      startupScriptService.hasStartupScript(context.workspaceWithProject.project),
    buildProjectConfig: (context) => context.workspaceWithProject.project,
    logStart: (context) => {
      const project = context.workspaceWithProject.project;
      logger.info('Running startup script for workspace', {
        workspaceId: context.workspaceId,
        hasCommand: !!project.startupScriptCommand,
        hasScriptPath: !!project.startupScriptPath,
      });
    },
    scriptFailedLogMessage: 'Startup script failed but workspace created',
    cleanupFailedLogMessage: 'Failed to stop Claude sessions after startup script failure',
  },
];

async function runScriptPhase(
  context: StartupScriptPipelineContext,
  phaseDefinition: StartupScriptPhaseDefinition
): Promise<StartupScriptPipelineResult | null> {
  if (!phaseDefinition.shouldRun(context)) {
    return null;
  }

  phaseDefinition.logStart(context);
  const scriptResult = await startupScriptService.runStartupScript(
    { ...context.workspaceWithProject, worktreePath: context.worktreePath },
    phaseDefinition.buildProjectConfig(context)
  );

  if (!scriptResult.success) {
    const workspaceInitErrorMessage = await context.getWorkspaceInitErrorMessage();
    logger.warn(phaseDefinition.scriptFailedLogMessage, {
      workspaceId: context.workspaceId,
      error: workspaceInitErrorMessage,
    });
    try {
      await sessionService.stopWorkspaceSessions(context.workspaceId);
    } catch (error) {
      logger.warn(phaseDefinition.cleanupFailedLogMessage, {
        workspaceId: context.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    handled: true,
    phase: phaseDefinition.phase,
    success: scriptResult.success,
  };
}

export async function executeStartupScriptPipeline(
  context: StartupScriptPipelineContext
): Promise<StartupScriptPipelineResult> {
  for (const phaseDefinition of scriptPhaseDefinitions) {
    const phaseResult = await runScriptPhase(context, phaseDefinition);
    if (phaseResult) {
      return phaseResult;
    }
  }

  return { handled: false, phase: null, success: true };
}
