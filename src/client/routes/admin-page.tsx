import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { CodexAccountsSettings } from '@/client/features/codex-accounts';
import { SlackSettings } from '@/client/features/slack';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ProjectSettingsRow } from './admin/project-settings-row';
import { SettingsPageLayout } from './admin/settings-page-layout';
import { SystemSettingsSection } from './admin/SystemSettingsSection';

function ProjectSettingsAccordion() {
  const [searchParams, setSearchParams] = useSearchParams();
  const expandedProject = searchParams.get('project');
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderIcon className="h-5 w-5" />
          Project settings
        </CardTitle>
        <CardDescription>
          Expand a project to configure its scripts and issue tracking.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.data.length ? (
          <ul className="divide-y rounded-md border">
            {query.data.map((project) => (
              <ProjectSettingsRow
                key={project.id}
                project={project}
                open={expandedProject === project.slug}
                onOpenChange={(open) => {
                  setSearchParams(
                    (previous) => {
                      const next = new URLSearchParams(previous);
                      if (open) {
                        next.set('project', project.slug);
                      } else {
                        next.delete('project');
                      }
                      return next;
                    },
                    { replace: true }
                  );
                }}
              />
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
      </CardContent>
    </Card>
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
      return <ProjectSettingsAccordion />;
    default:
      return <Navigate to="/admin" replace />;
  }
}

export default function AdminDashboardPage() {
  const { section = 'general' } = useParams<{ section: string }>();
  return (
    <SettingsPageLayout>
      <SettingsContent section={section} />
    </SettingsPageLayout>
  );
}
