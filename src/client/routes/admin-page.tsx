import { useState } from 'react';
import { HeaderLeftExtraSlot, useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { WorkspacesBackLink } from '@/client/features/workspace';
import { readSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ApiUsageSection,
  AppInfoSection,
  ChatProviderDefaultsSection,
  CliAuthSection,
  DataBackupSection,
  IdeSettingsSection,
  NotificationSettingsSection,
  PeriodicTasksSection,
  ProcessesSection,
  ProcessesSectionSkeleton,
  ProjectSettingsSection,
  RatchetSettingsSection,
  ServerLogsSection,
  VoiceModeSection,
} from './admin/index';

function resolveSelectedProjectSlug(
  projects: Array<{ slug: string }> | undefined
): string | undefined {
  if (!projects || projects.length === 0) {
    return undefined;
  }

  const storedSlug = readSelectedProjectSlug();
  if (storedSlug && projects.some((project) => project.slug === storedSlug)) {
    return storedSlug;
  }

  return projects[0]?.slug;
}

export default function AdminDashboardPage() {
  useAppHeader({ title: 'Settings' });
  const [settingsTab, setSettingsTab] = useState<
    'general' | 'project' | 'periodic-tasks' | 'voice'
  >('general');

  const {
    data: stats,
    isLoading: isLoadingStats,
    refetch,
  } = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const { data: processes, isLoading: isLoadingProcesses } = trpc.admin.getActiveProcesses.useQuery(
    undefined,
    {
      refetchInterval: 5000,
    }
  );

  // Get all projects for factory config section
  const { data: projects } = trpc.project.list.useQuery();

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      refetch();
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
        <Tabs
          value={settingsTab}
          onValueChange={(value) =>
            setSettingsTab(value as 'general' | 'project' | 'periodic-tasks' | 'voice')
          }
        >
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="general" className="flex-1 sm:flex-initial">
              General Settings
            </TabsTrigger>
            <TabsTrigger value="project" className="flex-1 sm:flex-initial">
              Project Settings
            </TabsTrigger>
            <TabsTrigger value="periodic-tasks" className="flex-1 sm:flex-initial">
              Periodic Tasks
            </TabsTrigger>
            <TabsTrigger value="voice" className="flex-1 sm:flex-initial">
              Voice Mode
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6 mt-4">
            <ApiUsageSection
              apiUsage={stats?.apiUsage}
              onReset={() => resetApiStats.mutate()}
              isResetting={resetApiStats.isPending}
            />

            {isLoadingProcesses ? (
              <ProcessesSectionSkeleton />
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
            <CliAuthSection />
            <RatchetSettingsSection />
            <AppInfoSection />
            <DataBackupSection />
            <ServerLogsSection />
          </TabsContent>

          <TabsContent value="project" className="mt-4">
            {projects ? (
              <ProjectSettingsSection projects={projects} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading projects...</p>
            )}
          </TabsContent>

          <TabsContent value="periodic-tasks" className="mt-4">
            {projects ? (
              <PeriodicTasksSection projects={projects} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading projects...</p>
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
