import type { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';
import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';

export function resolveRatchetProviderFromWorkspace(workspace: {
  ratchetSessionProvider: WorkspaceProviderSelection;
  defaultSessionProvider: WorkspaceProviderSelection;
}): SessionProvider | null {
  return (
    asConcreteWorkspaceProvider(workspace.ratchetSessionProvider) ??
    asConcreteWorkspaceProvider(workspace.defaultSessionProvider)
  );
}
