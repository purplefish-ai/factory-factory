import type { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { resolveRatchetProviderFromWorkspace } from './provider-selection';

type RatchetProviderWorkspace = {
  id: string;
  ratchetSessionProvider?: WorkspaceProviderSelection | null;
  defaultSessionProvider?: WorkspaceProviderSelection | null;
};

class RatchetProviderResolverService {
  async resolveRatchetProvider(params: {
    workspaceId: string;
    workspace?: RatchetProviderWorkspace;
  }): Promise<SessionProvider> {
    const workspace = params.workspace ?? (await workspaceAccessor.findRawById(params.workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${params.workspaceId}`);
    }

    const selectedProvider = resolveRatchetProviderFromWorkspace(workspace);
    if (selectedProvider) {
      return selectedProvider;
    }

    return userSettingsAccessor.getDefaultSessionProvider();
  }
}

export const ratchetProviderResolverService = new RatchetProviderResolverService();
