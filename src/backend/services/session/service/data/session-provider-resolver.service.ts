import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import type { SessionProvider, UserSettings, Workspace } from '@prisma-gen/client';

export interface SessionProviderResolverDependencies {
  getDefaultSessionProvider(): Promise<SessionProvider>;
  getModelDefaults(): Promise<Pick<UserSettings, 'defaultClaudeModel' | 'defaultCodexModel'>>;
  findWorkspace(id: string): Promise<Pick<Workspace, 'defaultSessionProvider'> | null>;
}

class SessionProviderResolverImplementation {
  constructor(private readonly dependencies: SessionProviderResolverDependencies) {}

  async resolveSessionDefaults(params: {
    workspaceId: string;
    explicitProvider?: SessionProvider;
    explicitModel?: string;
    workspace?: Workspace;
  }): Promise<{ provider: SessionProvider; model: string }> {
    const provider = await this.resolveSessionProvider(params);
    const settings = await this.dependencies.getModelDefaults();
    const configuredModel =
      provider === 'CLAUDE' ? settings.defaultClaudeModel : settings.defaultCodexModel;

    return {
      provider,
      model: resolveSessionModelForProvider(params.explicitModel, provider, configuredModel),
    };
  }

  async resolveProviderForWorkspaceCreation(
    explicitProvider?: SessionProvider,
    explicitModel?: string
  ): Promise<SessionProvider> {
    const provider = explicitProvider ?? (await this.dependencies.getDefaultSessionProvider());
    resolveSessionModelForProvider(explicitModel, provider);
    return provider;
  }

  async resolveSessionProvider(params: {
    workspaceId: string;
    explicitProvider?: SessionProvider;
    workspace?: Workspace;
  }): Promise<SessionProvider> {
    if (params.explicitProvider) {
      return params.explicitProvider;
    }

    const workspace =
      params.workspace ?? (await this.dependencies.findWorkspace(params.workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${params.workspaceId}`);
    }

    const workspaceProvider = asConcreteWorkspaceProvider(workspace.defaultSessionProvider);
    if (workspaceProvider) {
      return workspaceProvider;
    }

    return this.dependencies.getDefaultSessionProvider();
  }
}

export type SessionProviderResolverService = Pick<
  SessionProviderResolverImplementation,
  keyof SessionProviderResolverImplementation
>;

export function createSessionProviderResolverService(
  dependencies: SessionProviderResolverDependencies
): SessionProviderResolverService {
  return new SessionProviderResolverImplementation(dependencies);
}

export const sessionProviderResolverService = createSessionProviderResolverService({
  getDefaultSessionProvider: () => userSettingsService.getDefaultSessionProvider(),
  getModelDefaults: () => userSettingsService.get(),
  findWorkspace: (id) => workspaceDataService.findById(id),
});
