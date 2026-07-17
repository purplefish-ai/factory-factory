import type { SessionProvider, Workspace } from '@prisma-gen/client';
import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceAccessor } from '@/backend/services/workspace';

class SessionProviderResolverService {
  async resolveSessionDefaults(params: {
    workspaceId: string;
    explicitProvider?: SessionProvider;
    explicitModel?: string;
    workspace?: Workspace;
  }): Promise<{ provider: SessionProvider; model: string }> {
    const provider = await this.resolveSessionProvider(params);
    const settings = await userSettingsService.get();
    const configuredModel =
      provider === 'CLAUDE' ? settings.defaultClaudeModel : settings.defaultCodexModel;

    return {
      provider,
      model: resolveSessionModelForProvider(params.explicitModel, provider, configuredModel),
    };
  }

  async resolveProviderForWorkspaceCreation(
    explicitProvider?: SessionProvider
  ): Promise<SessionProvider> {
    if (explicitProvider) {
      return explicitProvider;
    }

    return await userSettingsService.getDefaultSessionProvider();
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

    return userSettingsService.getDefaultSessionProvider();
  }
}

export const sessionProviderResolverService = new SessionProviderResolverService();
