import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';

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
