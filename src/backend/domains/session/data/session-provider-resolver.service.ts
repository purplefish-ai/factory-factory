import type { SessionProvider, Workspace, WorkspaceProviderSelection } from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';

function asConcreteProvider(selection: WorkspaceProviderSelection): SessionProvider | null {
  return selection === 'WORKSPACE_DEFAULT' ? null : selection;
}

class SessionProviderResolverService {
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

    const workspaceProvider = asConcreteProvider(workspace.defaultSessionProvider);
    if (workspaceProvider) {
      return workspaceProvider;
    }

    const settings = await userSettingsAccessor.get();
    return settings.defaultSessionProvider;
  }

  async resolveRatchetProvider(params: {
    workspaceId: string;
    workspace?: Workspace;
  }): Promise<SessionProvider> {
    const workspace = params.workspace ?? (await workspaceAccessor.findRawById(params.workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${params.workspaceId}`);
    }

    const ratchetProvider = asConcreteProvider(workspace.ratchetSessionProvider);
    if (ratchetProvider) {
      return ratchetProvider;
    }

    return this.resolveSessionProvider({
      workspaceId: workspace.id,
      workspace,
    });
  }
}

export const sessionProviderResolverService = new SessionProviderResolverService();
