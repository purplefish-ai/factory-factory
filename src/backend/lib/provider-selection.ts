import type { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';

export function asConcreteWorkspaceProvider(
  selection: WorkspaceProviderSelection | null | undefined
): SessionProvider | null {
  if (!selection || selection === 'WORKSPACE_DEFAULT') {
    return null;
  }

  return selection;
}
