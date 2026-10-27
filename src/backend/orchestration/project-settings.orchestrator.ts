import { ApplicationError } from '@/backend/lib/application-error';
import type { projectManagementService } from '@/backend/services/workspace';
import type { Project } from '@prisma-gen/client';

export type ProjectSettingsInput = {
  id: string;
} & Omit<Parameters<typeof projectManagementService.update>[1], 'isArchived'>;

type SettingsPatch = Omit<ProjectSettingsInput, 'id'>;
type StartupState = Pick<Project, 'startupScriptCommand' | 'startupScriptPath'>;
const MAX_STARTUP_WRITE_ATTEMPTS = 5;

/** Only settings capabilities cross this application boundary; no transport context. */
export interface ProjectSettingsPorts {
  validateRepoPath: typeof projectManagementService.validateRepoPath;
  findById(id: string): Promise<StartupState | null>;
  update: typeof projectManagementService.update;
  updateIfStartupUnchanged: typeof projectManagementService.updateIfStartupUnchanged;
  encrypt(apiKey: string): string;
}

async function readValidStartupState(
  id: string,
  updates: SettingsPatch,
  ports: Pick<ProjectSettingsPorts, 'findById'>
): Promise<StartupState> {
  const current = await ports.findById(id);
  if (!current) {
    throw new Error(`Project not found: ${id}`);
  }
  const command =
    updates.startupScriptCommand !== undefined
      ? updates.startupScriptCommand
      : current.startupScriptCommand;
  const path =
    updates.startupScriptPath !== undefined ? updates.startupScriptPath : current.startupScriptPath;
  if (command && path) {
    throw new Error(
      'Cannot have both startupScriptCommand and startupScriptPath set. Please clear one by setting it to null.'
    );
  }
  return {
    startupScriptCommand: current.startupScriptCommand,
    startupScriptPath: current.startupScriptPath,
  };
}

function prepareUpdates(
  updates: SettingsPatch,
  ports: Pick<ProjectSettingsPorts, 'encrypt'>
): SettingsPatch {
  if (!updates.issueTrackerConfig?.linear?.apiKey) {
    return updates;
  }
  return {
    ...updates,
    issueTrackerConfig: {
      ...updates.issueTrackerConfig,
      linear: {
        ...updates.issueTrackerConfig.linear,
        apiKey: ports.encrypt(updates.issueTrackerConfig.linear.apiKey),
      },
    },
  };
}

/** Validate and encrypt once; condition startup writes on the pair we validated. */
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

  if (updates.startupScriptCommand === undefined && updates.startupScriptPath === undefined) {
    return ports.update(id, prepareUpdates(updates, ports));
  }

  let current = await readValidStartupState(id, updates, ports);
  // Keep the encrypted patch across retries: never encrypt ciphertext or persist plaintext.
  const prepared = prepareUpdates(updates, ports);
  for (let attempt = 0; attempt < MAX_STARTUP_WRITE_ATTEMPTS; attempt++) {
    const written = await ports.updateIfStartupUnchanged(id, current, prepared);
    if (written) {
      return written;
    }
    // Recheck even after the final conflict so deletion/invariant errors retain precedence.
    current = await readValidStartupState(id, updates, ports);
  }
  throw new ApplicationError(
    'CONFLICT',
    'Project startup settings changed concurrently. Please retry.'
  );
}
