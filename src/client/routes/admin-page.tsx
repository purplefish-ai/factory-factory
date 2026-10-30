import { useState } from 'react';
import { HeaderLeftExtraSlot, useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { CodexAccountsSettings } from '@/client/features/codex-accounts';
import { WorkspacesBackLink } from '@/client/features/workspace';
import { runInBackground } from '@/client/lib/background-task';
import { resolveSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AdversarialReviewSection,
  ApiUsageSection,
  AppearanceSettingsSection,
  AppInfoSection,
  ChatProviderDefaultsSection,
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

type SettingsTab = 'general' | 'appearance' | 'project' | 'voice';

export default function AdminDashboardPage() {
  useAppHeader({ title: 'Settings' });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

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
      runInBackground(refetch(), 'Could not refresh data');
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
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="general" className="flex-1 sm:flex-initial">
              General Settings
            </TabsTrigger>
            <TabsTrigger value="appearance" className="flex-1 sm:flex-initial">
              Appearance
            </TabsTrigger>
            <TabsTrigger value="project" className="flex-1 sm:flex-initial">
              Project Settings
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
            <CodexAccountsSettings />
            <CliAuthSection />
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
