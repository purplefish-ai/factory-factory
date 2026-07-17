import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor, workspaceDataService } from '@/backend/services/workspace';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';
import { FactoryConfigService } from './factory-config.service';

const logger = createLogger('run-script-config-persistence');
const FACTORY_CONFIG_FILENAME = 'factory-factory.json';

export type RunScriptCommandCache = {
  runScriptCommand: string | null;
  runScriptPostRunCommand: string | null;
  runScriptCleanupCommand: string | null;
};

type WorkspaceRunScriptFields = RunScriptCommandCache & {
  id: string;
  worktreePath: string | null;
};

export type PersistWorkspaceCommands = (
  workspaceId: string,
  commands: RunScriptCommandCache
) => Promise<unknown>;

function commandsFromFactoryConfig(config: FactoryConfig | null): RunScriptCommandCache {
  return {
    runScriptCommand: config?.scripts.run ?? null,
    runScriptPostRunCommand: config?.scripts.postRun ?? null,
    runScriptCleanupCommand: config?.scripts.cleanup ?? null,
  };
}

function commandsFromWorkspace(workspace: WorkspaceRunScriptFields): RunScriptCommandCache {
  return {
    runScriptCommand: workspace.runScriptCommand,
    runScriptPostRunCommand: workspace.runScriptPostRunCommand,
    runScriptCleanupCommand: workspace.runScriptCleanupCommand,
  };
}

function commandsEqual(a: RunScriptCommandCache, b: RunScriptCommandCache): boolean {
  return (
    a.runScriptCommand === b.runScriptCommand &&
    a.runScriptPostRunCommand === b.runScriptPostRunCommand &&
    a.runScriptCleanupCommand === b.runScriptCleanupCommand
  );
}

class RunScriptConfigPersistenceService {
  async refreshFactoryConfigs(projectId: string): Promise<{
    updatedCount: number;
    totalWorkspaces: number;
    errors: Array<{ workspaceId: string; error: string }>;
  }> {
    const workspaces = await workspaceDataService.findByProjectId(projectId);
    let updatedCount = 0;
    const errors: Array<{ workspaceId: string; error: string }> = [];

    for (const workspace of workspaces) {
      if (!workspace.worktreePath) {
        continue;
      }

      try {
        await this.syncWorkspaceCommandsFromWorktreeConfig({
          workspaceId: workspace.id,
          worktreePath: workspace.worktreePath,
          persistWorkspaceCommands: (id, commands) =>
            workspaceDataService.setRunScriptCommands(
              id,
              commands.runScriptCommand,
              commands.runScriptPostRunCommand,
              commands.runScriptCleanupCommand
            ),
        });
        updatedCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ workspaceId: workspace.id, error: message });
        logger.error('Failed to refresh factory config for workspace', {
          workspaceId: workspace.id,
          error: message,
        });
      }
    }

    return { updatedCount, totalWorkspaces: workspaces.length, errors };
  }

  async getFactoryConfig(projectId: string): Promise<FactoryConfig | null> {
    const project = await projectAccessor.findById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    try {
      return await FactoryConfigService.readConfig(project.repoPath);
    } catch (error) {
      logger.error('Failed to read factory config', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async syncWorkspaceCommandsFromFactoryConfig(input: {
    workspaceId: string;
    factoryConfig: FactoryConfig | null;
    persistWorkspaceCommands: PersistWorkspaceCommands;
  }): Promise<RunScriptCommandCache> {
    const commands = commandsFromFactoryConfig(input.factoryConfig);
    await input.persistWorkspaceCommands(input.workspaceId, commands);
    return commands;
  }

  async syncWorkspaceCommandsFromWorktreeConfig(input: {
    workspaceId: string;
    worktreePath: string;
    persistWorkspaceCommands: PersistWorkspaceCommands;
  }): Promise<RunScriptCommandCache> {
    const factoryConfig = await FactoryConfigService.readConfig(input.worktreePath);
    return this.syncWorkspaceCommandsFromFactoryConfig({
      workspaceId: input.workspaceId,
      factoryConfig,
      persistWorkspaceCommands: input.persistWorkspaceCommands,
    });
  }

  async writeFactoryConfigAndSyncWorkspace(input: {
    workspaceId: string;
    worktreePath: string;
    projectRepoPath?: string | null;
    config: FactoryConfig;
    persistWorkspaceCommands: PersistWorkspaceCommands;
  }): Promise<RunScriptCommandCache> {
    const configContent = JSON.stringify(input.config, null, 2);

    await writeFile(join(input.worktreePath, FACTORY_CONFIG_FILENAME), configContent, 'utf-8');

    if (input.projectRepoPath) {
      await writeFile(join(input.projectRepoPath, FACTORY_CONFIG_FILENAME), configContent, 'utf-8');
    }

    return this.syncWorkspaceCommandsFromFactoryConfig({
      workspaceId: input.workspaceId,
      factoryConfig: input.config,
      persistWorkspaceCommands: input.persistWorkspaceCommands,
    });
  }

  async reconcileWorkspaceCommandCache(input: {
    workspace: WorkspaceRunScriptFields;
    persistWorkspaceCommands: PersistWorkspaceCommands;
  }): Promise<RunScriptCommandCache> {
    const workspace = input.workspace;
    if (!workspace.worktreePath) {
      return commandsFromWorkspace(workspace);
    }

    const factoryConfig = await FactoryConfigService.readConfig(workspace.worktreePath);
    const canonicalCommands = commandsFromFactoryConfig(factoryConfig);
    const cachedCommands = commandsFromWorkspace(workspace);

    if (commandsEqual(canonicalCommands, cachedCommands)) {
      return canonicalCommands;
    }

    await input.persistWorkspaceCommands(workspace.id, canonicalCommands);
    logger.info('Repaired run-script command cache drift from factory config', {
      workspaceId: workspace.id,
      hadRunScriptBefore: !!cachedCommands.runScriptCommand,
      hasRunScriptAfter: !!canonicalCommands.runScriptCommand,
    });

    return canonicalCommands;
  }
}

export const runScriptConfigPersistenceService = new RunScriptConfigPersistenceService();
