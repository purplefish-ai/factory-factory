import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { CodexAccountsSettings } from '@/client/features/codex-accounts';
import { SlackSettings } from '@/client/features/slack';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { ProjectSettingsSection } from './admin/ProjectSettingsSection';
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
              <Collapsible
                key={project.id}
                asChild
                open={expandedProject === project.slug}
                onOpenChange={(open) => {
                  setSearchParams((previous) => {
                    const next = new URLSearchParams(previous);
                    if (open) {
                      next.set('project', project.slug);
                    } else {
                      next.delete('project');
                    }
                    return next;
                  });
                }}
              >
                <li>
                  <h2>
                    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-ring">
                      <span className="min-w-0 break-words">{project.name}</span>
                      <CaretRightIcon
                        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                        aria-hidden="true"
                      />
                    </CollapsibleTrigger>
                  </h2>
                  <CollapsibleContent className="min-w-0 space-y-4 p-3 pt-0">
                    <ProjectSettingsSection project={project} />
                  </CollapsibleContent>
                </li>
              </Collapsible>
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
