import type { SessionProvider, Workspace } from '@prisma-gen/client';
import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';

class SessionProviderResolverService {
  async resolveSessionDefaults(params: {
    workspaceId: string;
    explicitProvider?: SessionProvider;
    explicitModel?: string;
    workspace?: Workspace;
  }): Promise<{ provider: SessionProvider; model: string }> {
    const provider = await this.resolveSessionProvider(params);
    const settings = await userSettingsService.get();
    // OpenHands resolves its model from the LLM_MODEL env var at spawn time;
    // there is no per-provider configured model to fall back to, so it returns
    // undefined and resolveSessionModelForProvider applies the 'env' sentinel.
    const configuredModel =
      provider === 'CLAUDE'
        ? settings.defaultClaudeModel
        : provider === 'CODEX'
          ? settings.defaultCodexModel
          : undefined;

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

    const workspace = params.workspace ?? (await workspaceDataService.findById(params.workspaceId));
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
