import { useState } from 'react';
import { toast } from 'sonner';
import { HeaderLeftExtraSlot, useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { CodexAccountsSettings } from '@/client/features/codex-accounts';
import { SlackSettings } from '@/client/features/slack';
import { WorkspacesBackLink } from '@/client/features/workspace';
import { runInBackground } from '@/client/lib/background-task';
import { resolveSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import {
  AdversarialReviewSection,
  ApiUsageSection,
  AppearanceSettingsSection,
  AppInfoSection,
  ChatProviderDefaultsSection,
  ChildWorkspaceSettingsSection,
  CliAuthSection,
  DataBackupSection,
  IdeSettingsSection,
  NotificationSettingsSection,
  ProcessesSection,
  ProcessesSectionSkeleton,
  ProjectSettingsSection,
  RatchetSettingsSection,
  ServerLogsSection,
  VoiceModeSection,
  WorktreeCleanupSection,
} from './admin/index';
import { SettingsTabsList } from './admin/settings-tabs-list';

type SettingsTab = 'general' | 'appearance' | 'project' | 'voice';

function SectionQueryError(props: React.ComponentProps<typeof QueryErrorState>) {
  return (
    <Card>
      <CardContent className="p-0">
        <QueryErrorState {...props} />
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  useAppHeader({ title: 'Settings' });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

  const statsQuery = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: stats, isLoading: isLoadingStats, refetch } = statsQuery;

  const processesQuery = trpc.admin.getActiveProcesses.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: processes, isLoading: isLoadingProcesses } = processesQuery;

  // Get all projects for factory config section
  const projectsQuery = trpc.project.list.useQuery();
  const { data: projects } = projectsQuery;

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      runInBackground(refetch(), 'Could not refresh data');
    },
    onError: (error) => {
      toast.error("Couldn't reset API usage stats", { description: error.message });
    },
  });

  const projectSlug = resolveSelectedProjectSlug(projects);

  // Show full loading only when stats are loading (first load)
  if (isLoadingStats) {
    return <Loading message="Loading settings..." />;
  }

  return (
    <div className="h-full overflow-y-auto">
      {projectSlug && (
        <HeaderLeftExtraSlot>
          <WorkspacesBackLink projectSlug={projectSlug} />
        </HeaderLeftExtraSlot>
      )}
      <div className="space-y-6 p-3 md:p-6">
        <Tabs value={settingsTab} onValueChange={(value) => setSettingsTab(value as SettingsTab)}>
          <SettingsTabsList />

          <TabsContent value="general" className="space-y-6 mt-4">
            {statsQuery.error && !stats ? (
              <SectionQueryError
                title="Couldn't load API usage"
                error={statsQuery.error}
                onRetry={() => void refetch()}
                isRetrying={statsQuery.isFetching}
              />
            ) : (
              <ApiUsageSection
                apiUsage={stats?.apiUsage}
                onReset={() => resetApiStats.mutateAsync()}
                isResetting={resetApiStats.isPending}
              />
            )}

            {isLoadingProcesses ? (
              <ProcessesSectionSkeleton />
            ) : processesQuery.error && !processes ? (
              <SectionQueryError
                title="Couldn't load active processes"
                error={processesQuery.error}
                onRetry={() => void processesQuery.refetch()}
                isRetrying={processesQuery.isFetching}
              />
            ) : (
              <ProcessesSection processes={processes} />
            )}

            {/* Environment Info */}
            <Card className="bg-muted/50">
              <CardContent className="py-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium">Environment:</span>
                  <Badge variant="outline">{stats?.environment || 'unknown'}</Badge>
                </div>
              </CardContent>
            </Card>

            <NotificationSettingsSection />
            <IdeSettingsSection />
            <ChatProviderDefaultsSection />
            <ChildWorkspaceSettingsSection />
            <CodexAccountsSettings />
            <CliAuthSection />
            <SlackSettings />
            <RatchetSettingsSection />
            <AdversarialReviewSection />
            <AppInfoSection />
            <DataBackupSection />
            <WorktreeCleanupSection />
            <ServerLogsSection />
          </TabsContent>

          <TabsContent value="appearance" className="mt-4">
            <AppearanceSettingsSection />
          </TabsContent>

          <TabsContent value="project" className="mt-4">
            {projects ? (
              <ProjectSettingsSection projects={projects} />
            ) : projectsQuery.error ? (
              <SectionQueryError
                title="Couldn't load projects"
                error={projectsQuery.error}
                onRetry={() => void projectsQuery.refetch()}
                isRetrying={projectsQuery.isFetching}
              />
            ) : (
              <Loading size="compact" message="Loading projects…" />
            )}
          </TabsContent>

          <TabsContent value="voice" className="mt-4">
            <VoiceModeSection />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
