import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
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
import { ProjectSettingsRow } from './admin/project-settings-row';
import { SettingsPageLayout } from './admin/settings-page-layout';
import { SettingsSection } from './admin/settings-section';
import { SystemSettingsSection } from './admin/SystemSettingsSection';

function ProjectSettingsAccordion() {
  const [searchParams, setSearchParams] = useSearchParams();
  const expandedProject = searchParams.get('project');
  const query = trpc.project.list.useQuery();
  const setExpanded = (slug: string, open: boolean) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (open) {
          next.set('project', slug);
        } else {
          next.delete('project');
        }
        return next;
      },
      { replace: true }
    );
  };
  return (
    <SettingsSection
      title="Project settings"
      icon={<FolderIcon className="h-5 w-5" />}
      description="Expand a project to configure its scripts and issue tracking."
      query={query}
      errorTitle="Couldn't load projects"
    >
      {(projects) =>
        projects.length ? (
          <ul className="divide-y rounded-md border">
            {projects.map((project) => (
              <ProjectSettingsRow
                key={project.id}
                project={project}
                open={expandedProject === project.slug}
                onOpenChange={(open) => setExpanded(project.slug, open)}
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
        )
      }
    </SettingsSection>
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
