import { Link, useParams } from 'react-router';
import { useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { WorkspacesBackLink } from '@/client/features/workspace/workspaces-back-link';
import { trpc } from '@/client/lib/trpc';
import { ProjectSettingsSection } from '@/client/routes/admin/ProjectSettingsSection';
import { SettingsPageLayout } from '@/client/routes/admin/settings-page-layout';

export default function ProjectSettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const query = trpc.project.list.useQuery();
  const project = query.data?.find((candidate) => candidate.slug === slug);
  useAppHeader({ title: project ? `${project.name} settings` : 'Project settings' });
  return (
    <SettingsPageLayout
      projectSettings
      breadcrumb={
        <>
          <Link className="underline" to="/admin">
            Settings
          </Link>{' '}
          /{' '}
          <Link className="underline" to="/admin/project">
            Projects
          </Link>{' '}
          / <span className="break-words">{project?.name ?? slug}</span>
        </>
      }
    >
      {project ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="min-w-0 break-words text-xl font-semibold">{project.name} settings</h1>
            <WorkspacesBackLink projectSlug={project.slug} />
          </div>
          <ProjectSettingsSection key={project.id} project={project} />
        </>
      ) : query.error ? (
        <QueryErrorState
          title="Couldn't load project settings"
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : !query.data ? (
        <Loading message="Loading project settings…" />
      ) : (
        <p role="alert">
          Project not found.{' '}
          <Link className="underline" to="/admin/project">
            Choose a project
          </Link>
        </p>
      )}
    </SettingsPageLayout>
  );
}
