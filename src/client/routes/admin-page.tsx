import { Link, Navigate, useParams } from 'react-router';
import { useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { CodexAccountsSettings } from '@/client/features/codex-accounts';
import { SlackSettings } from '@/client/features/slack';
import { trpc } from '@/client/lib/trpc';
import {
  AdversarialReviewSection,
  AppearanceSettingsSection,
  ChatProviderDefaultsSection,
  ChildWorkspaceSettingsSection,
  TicketDispatchSettingsSection,
  CliAuthSection,
  IdeSettingsSection,
  NotificationSettingsSection,
  RatchetSettingsSection,
  VoiceModeSection,
} from './admin/index';
import { SettingsPageLayout } from './admin/settings-page-layout';
import { SystemSettingsSection } from './admin/SystemSettingsSection';

function ProjectSettingsLinks() {
  const query = trpc.project.list.useQuery();
  if (!query.data) {
    return query.error ? (
      <QueryErrorState
        title="Couldn't load projects"
        error={query.error}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    ) : (
      <Loading size="compact" message="Loading projects…" />
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Project settings</h2>
      <p className="text-sm text-muted-foreground">
        Choose a project to configure its scripts and issue tracking.
      </p>
      {query.data.length ? (
        <ul className="space-y-2">
          {query.data.map((project) => (
            <li key={project.id}>
              <Link className="underline" to={`/projects/${project.slug}/settings`}>
                {project.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No projects yet.{' '}
          <Link className="underline" to="/projects/new">
            Add a project
          </Link>
        </p>
      )}
    </section>
  );
}

function SettingsContent({ section }: { section: string }) {
  switch (section) {
    case 'general':
      return (
        <>
          <NotificationSettingsSection />
          <IdeSettingsSection />
          <ChatProviderDefaultsSection />
        </>
      );
    case 'workspace':
      return (
        <>
          <ChildWorkspaceSettingsSection />
          <TicketDispatchSettingsSection />
          <RatchetSettingsSection />
          <AdversarialReviewSection />
        </>
      );
    case 'integrations':
      return (
        <>
          <CodexAccountsSettings />
          <CliAuthSection />
          <SlackSettings />
        </>
      );
    case 'appearance':
      return <AppearanceSettingsSection />;
    case 'voice':
      return <VoiceModeSection />;
    case 'system':
      return <SystemSettingsSection />;
    case 'project':
      return <ProjectSettingsLinks />;
    default:
      return <Navigate to="/admin" replace />;
  }
}

export default function AdminDashboardPage() {
  const { section = 'general' } = useParams<{ section: string }>();
  useAppHeader({ title: 'Settings' });
  return (
    <SettingsPageLayout>
      <SettingsContent section={section} />
    </SettingsPageLayout>
  );
}
