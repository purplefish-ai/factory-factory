import { toast } from 'sonner';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  ApiUsageSection,
  AppInfoSection,
  DataBackupSection,
  ProcessesSection,
  ProcessesSectionSkeleton,
  ServerLogsSection,
  WorktreeCleanupSection,
} from './index';

function SectionQueryError(props: React.ComponentProps<typeof QueryErrorState>) {
  return (
    <Card>
      <CardContent className="p-0">
        <QueryErrorState {...props} />
      </CardContent>
    </Card>
  );
}

export function SystemSettingsSection() {
  const statsQuery = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: stats, isLoading: isLoadingStats, refetch } = statsQuery;

  const processesQuery = trpc.admin.getActiveProcesses.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: processes, isLoading: isLoadingProcesses } = processesQuery;

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      runInBackground(refetch(), "Couldn't refresh data.");
    },
    onError: (error) => {
      toast.error("Couldn't reset API usage stats.", { description: error.message });
    },
  });

  return (
    <>
      {isLoadingStats ? (
        <Loading size="compact" message="Loading API usage…" />
      ) : statsQuery.error && !stats ? (
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

      <AppInfoSection />
      <DataBackupSection />
      <WorktreeCleanupSection />
      <ServerLogsSection />
    </>
  );
}
