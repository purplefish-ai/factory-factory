import type { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';
import { asConcreteWorkspaceProvider } from '@/backend/lib/provider-selection';

export function resolveRatchetProviderFromWorkspace(workspace: {
  ratchetSessionProvider?: WorkspaceProviderSelection | null;
  defaultSessionProvider?: WorkspaceProviderSelection | null;
}): SessionProvider | null {
  return (
    asConcreteWorkspaceProvider(workspace.ratchetSessionProvider) ??
    asConcreteWorkspaceProvider(workspace.defaultSessionProvider)
  );
}
