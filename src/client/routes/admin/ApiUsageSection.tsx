import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from './StatCard';

export interface ApiUsageData {
  requestsLastMinute: number;
  requestsLastHour: number;
  totalRequests: number;
  queueDepth: number;
  isRateLimited: boolean;
}

export interface ApiUsageSectionProps {
  apiUsage?: ApiUsageData;
  onReset: () => void;
  isResetting: boolean;
}

export function ApiUsageSection({ apiUsage, onReset, isResetting }: ApiUsageSectionProps) {
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
