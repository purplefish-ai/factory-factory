import type { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';

type ProviderSelection = WorkspaceProviderSelection | null | undefined;

function asConcreteProvider(selection: ProviderSelection): SessionProvider | null {
  if (!selection || selection === 'WORKSPACE_DEFAULT') {
    return null;
  }

  return selection;
}

export function resolveRatchetProviderFromWorkspace(workspace: {
  ratchetSessionProvider?: WorkspaceProviderSelection | null;
  defaultSessionProvider?: WorkspaceProviderSelection | null;
}): SessionProvider | null {
  return (
    asConcreteProvider(workspace.ratchetSessionProvider) ??
    asConcreteProvider(workspace.defaultSessionProvider)
  );
}
