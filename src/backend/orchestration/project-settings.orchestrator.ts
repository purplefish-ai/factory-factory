import type { projectManagementService } from '@/backend/services/workspace';
import type { Project } from '@prisma-gen/client';

export type ProjectSettingsInput = {
  id: string;
} & Omit<Parameters<typeof projectManagementService.update>[1], 'isArchived'>;

/** Only settings capabilities cross this application boundary; no transport context. */
export interface ProjectSettingsPorts {
  validateRepoPath: typeof projectManagementService.validateRepoPath;
  findById(id: string): Promise<Pick<Project, 'startupScriptCommand' | 'startupScriptPath'> | null>;
  update: typeof projectManagementService.update;
  encrypt(apiKey: string): string;
}

/** Validate the final settings and encrypt credentials before the single write. */
export async function updateProjectSettings(
  input: ProjectSettingsInput,
  ports: ProjectSettingsPorts
) {
  const { id, ...updates } = input;

  if (updates.repoPath) {
    const validation = await ports.validateRepoPath(updates.repoPath);
    if (!validation.valid) {
      throw new Error(`Invalid repository path: ${validation.error}`);
    }
  }

  if (updates.startupScriptCommand !== undefined || updates.startupScriptPath !== undefined) {
    const currentProject = await ports.findById(id);
    if (!currentProject) {
      throw new Error(`Project not found: ${id}`);
    }
    const command =
      updates.startupScriptCommand !== undefined
        ? updates.startupScriptCommand
        : currentProject.startupScriptCommand;
    const path =
      updates.startupScriptPath !== undefined
        ? updates.startupScriptPath
        : currentProject.startupScriptPath;
    if (command && path) {
      throw new Error(
        'Cannot have both startupScriptCommand and startupScriptPath set. Please clear one by setting it to null.'
      );
    }
  }

  if (updates.issueTrackerConfig?.linear?.apiKey) {
    updates.issueTrackerConfig = {
      ...updates.issueTrackerConfig,
      linear: {
        ...updates.issueTrackerConfig.linear,
        apiKey: ports.encrypt(updates.issueTrackerConfig.linear.apiKey),
      },
    };
  }

  // Internal callers retain the raw project; the transport owns public projection.
  return ports.update(id, updates);
}
