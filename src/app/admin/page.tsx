'use client';

import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../frontend/lib/trpc';

function StatCard({
  title,
  value,
  subtitle,
  status,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  status?: 'ok' | 'warning' | 'error';
}) {
  const statusColors = {
    ok: 'border-l-success',
    warning: 'border-l-warning',
    error: 'border-l-destructive',
  };

  return (
    <Card className={`border-l-4 ${status ? statusColors[status] : 'border-l-muted'}`}>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {subtitle && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </CardContent>
      )}
    </Card>
  );
}

function getEnabledFeatures(features?: Record<string, boolean>): string {
  if (!features) {
    return 'none';
  }
  const enabled = Object.entries(features)
    .filter(([, isEnabled]) => isEnabled)
    .map(([feature]) => feature);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

interface ApiUsageData {
  requestsLastMinute: number;
  requestsLastHour: number;
  totalRequests: number;
  queueDepth: number;
  isRateLimited: boolean;
}

function ApiUsageSection({
  apiUsage,
  onReset,
  isResetting,
}: {
  apiUsage?: ApiUsageData;
  onReset: () => void;
  isResetting: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle>API Usage</CardTitle>
        <Button variant="link" onClick={onReset} disabled={isResetting} className="h-auto p-0">
          Reset Stats
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            title="Requests/min"
            value={apiUsage?.requestsLastMinute || 0}
            status={apiUsage?.isRateLimited ? 'warning' : 'ok'}
          />
          <StatCard title="Requests/hour" value={apiUsage?.requestsLastHour || 0} />
          <StatCard title="Total Requests" value={apiUsage?.totalRequests || 0} />
          <StatCard
            title="Queue Depth"
            value={apiUsage?.queueDepth || 0}
            status={apiUsage?.queueDepth && apiUsage.queueDepth > 10 ? 'warning' : 'ok'}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface ConcurrencyData {
  activeWorkers: number;
  activeSupervisors: number;
  activeTopLevelTasks: number;
  limits: { maxWorkers: number; maxSupervisors: number; maxTopLevelTasks: number };
}

function ConcurrencySection({ concurrency }: { concurrency?: ConcurrencyData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrency</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Active Workers"
            value={`${concurrency?.activeWorkers || 0} / ${concurrency?.limits?.maxWorkers || 0}`}
          />
          <StatCard
            title="Active Supervisors"
            value={`${concurrency?.activeSupervisors || 0} / ${concurrency?.limits?.maxSupervisors || 0}`}
          />
          <StatCard
            title="Active Top-Level Tasks"
            value={`${concurrency?.activeTopLevelTasks || 0} / ${concurrency?.limits?.maxTopLevelTasks || 0}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  const {
    data: stats,
    isLoading,
    refetch,
  } = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) {
    return <Loading message="Loading admin dashboard..." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Admin Dashboard" description="System monitoring and management">
        <Badge variant="outline" className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Simplified Model
        </Badge>
      </PageHeader>

      <ApiUsageSection
        apiUsage={stats?.apiUsage}
        onReset={() => resetApiStats.mutate()}
        isResetting={resetApiStats.isPending}
      />

      <ConcurrencySection concurrency={stats?.concurrency} />

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Admin Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 flex-wrap">
            <Button variant="secondary" asChild>
              <Link href="/admin/system">System Settings</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Environment Info */}
      <Card className="bg-muted/50">
        <CardContent className="py-4">
          <span className="font-medium">Environment:</span>{' '}
          <Badge variant="outline">{stats?.environment || 'unknown'}</Badge>
          <span className="mx-2">|</span>
          <span className="font-medium">Features:</span>{' '}
          <span className="text-muted-foreground">{getEnabledFeatures(stats?.features)}</span>
        </CardContent>
      </Card>
    </div>
  );
}
