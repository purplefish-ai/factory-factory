import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
import { trpc } from '@/client/lib/trpc';

export function useWorkspaceProjectNavigation() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });

  const handleProjectChange = useCallback(
    (value: string) => {
      if (value === '__manage__') {
        void navigate('/projects');
        return;
      }
      if (value === '__create__') {
        void navigate('/projects/new');
        return;
      }
      void navigate(`/projects/${value}/workspaces`);
    },
    [navigate]
  );

  const handleCurrentProjectSelect = useCallback(() => {
    if (!slug) {
      return;
    }
    void navigate(`/projects/${slug}/workspaces`);
  }, [navigate, slug]);

  return { slug, projects, handleProjectChange, handleCurrentProjectSelect };
}
