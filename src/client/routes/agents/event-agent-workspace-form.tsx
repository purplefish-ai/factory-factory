import { useNavigate } from 'react-router';
import { InlineWorkspaceForm } from '@/client/features/kanban/inline-workspace-form';
import { trpc } from '@/client/lib/trpc';

/** Route composition keeps workspace creation out of the agents/kanban feature cycle. */
export function EventAgentWorkspaceForm({
  projectId,
  projectSlug,
  onCancel,
}: {
  projectId: string;
  projectSlug: string;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const workspaces = trpc.workspace.listForProject.useQuery({ projectId });
  return (
    <InlineWorkspaceForm
      key={projectId}
      projectId={projectId}
      purpose="event-agent"
      existingNames={workspaces.data?.workspaces.map((workspace) => workspace.name) ?? []}
      onCancel={onCancel}
      onCreated={(workspaceId) => {
        void navigate(
          `/projects/${encodeURIComponent(projectSlug)}/workspaces/${encodeURIComponent(workspaceId)}`
        );
      }}
    />
  );
}
