import type { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import { startupScriptService } from '@/backend/services/run-script';
import { workspaceStateMachine } from '@/backend/services/workspace';
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
}

interface StartupScriptPhaseDefinition {
  phase: StartupScriptPhase;
  shouldRun: (context: StartupScriptPipelineContext) => boolean;
  buildProjectConfig: (
    context: StartupScriptPipelineContext
  ) => StartupScriptPipelineContext['workspaceWithProject']['project'];
  logStart: (context: StartupScriptPipelineContext) => void;
  scriptFailedLogMessage: string;
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
    scriptFailedLogMessage: 'Setup script from factory-factory.json failed (non-blocking)',
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
    scriptFailedLogMessage: 'Startup script failed (non-blocking)',
  },
];

interface PhaseResult {
  failed: boolean;
  errorMessage?: string;
}

async function runScriptPhase(
  context: StartupScriptPipelineContext,
  phaseDefinition: StartupScriptPhaseDefinition
): Promise<PhaseResult | null> {
  if (!phaseDefinition.shouldRun(context)) {
    return null;
  }

  phaseDefinition.logStart(context);
  const scriptResult = await startupScriptService.runStartupScript(
    { ...context.workspaceWithProject, worktreePath: context.worktreePath },
    phaseDefinition.buildProjectConfig(context),
    { deferStateTransition: true }
  );

  if (!scriptResult.success) {
    logger.warn(phaseDefinition.scriptFailedLogMessage, {
      workspaceId: context.workspaceId,
      error: scriptResult.errorMessage,
    });
    return { failed: true, errorMessage: scriptResult.errorMessage };
  }

  return { failed: false };
}

export async function executeStartupScriptPipeline(
  context: StartupScriptPipelineContext
): Promise<StartupScriptPipelineResult> {
  let handled = false;
  let lastErrorMessage: string | undefined;

  for (const phaseDefinition of scriptPhaseDefinitions) {
    const phaseResult = await runScriptPhase(context, phaseDefinition);
    if (phaseResult !== null) {
      handled = true;
      if (phaseResult.failed && phaseResult.errorMessage) {
        lastErrorMessage = phaseResult.errorMessage;
      }
    }
  }

  if (!handled) {
    return { handled: false, phase: null, success: true };
  }

  // Single final state transition after all phases have run.
  // If any phase failed, workspace reaches READY with a warning banner.
  // The agent session continues normally regardless.
  if (lastErrorMessage) {
    await workspaceStateMachine.markReadyWithWarning(context.workspaceId, lastErrorMessage);
  } else {
    await workspaceStateMachine.markReady(context.workspaceId);
  }

  return { handled: true, phase: null, success: true };
}
