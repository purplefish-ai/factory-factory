import type { SessionProvider, Workspace } from '@prisma-gen/client';
import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';

class SessionProviderResolverService {
  async resolveProviderForWorkspaceCreation(
    explicitProvider?: SessionProvider
  ): Promise<SessionProvider> {
    if (explicitProvider) {
      return explicitProvider;
    }

    return await userSettingsAccessor.getDefaultSessionProvider();
  }

  async resolveSessionProvider(params: {
    workspaceId: string;
    explicitProvider?: SessionProvider;
    workspace?: Workspace;
  }): Promise<SessionProvider> {
    if (params.explicitProvider) {
      return params.explicitProvider;
    }

    const workspace = params.workspace ?? (await workspaceAccessor.findRawById(params.workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${params.workspaceId}`);
    }

    const workspaceProvider = asConcreteWorkspaceProvider(workspace.defaultSessionProvider);
    if (workspaceProvider) {
      return workspaceProvider;
    }

    return userSettingsAccessor.getDefaultSessionProvider();
  }
}

export const sessionProviderResolverService = new SessionProviderResolverService();
