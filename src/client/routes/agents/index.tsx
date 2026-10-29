import { useParams } from 'react-router';
import { ProjectSectionHeader } from '@/client/components/project-section-header';
import { AgentsPage } from '@/client/features/agents/agents-page';
import { trpc } from '@/client/lib/trpc';

export default function AgentsRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  const project = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });
  if (!project.data) {
    return null;
  } // ProjectLayout owns loading and error states.
  return (
    <>
      <ProjectSectionHeader project={project.data} />
      <AgentsPage key={project.data.id} project={project.data} />
    </>
  );
}
