import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsSection } from './settings-section';
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
  /**
   * Resets the counters. Resolve on success to close the confirmation; reject
   * on failure (after reporting it) to keep the dialog open for a retry.
   */
  onReset: () => Promise<unknown>;
  isResetting: boolean;
}

export function ApiUsageSection({ apiUsage, onReset, isResetting }: ApiUsageSectionProps) {
  // The counters cannot be restored after a reset, so it is confirmed first.
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <SettingsSection
      title="API usage"
      action={
        <Button
          variant="link"
          onClick={() => setConfirmOpen(true)}
          disabled={isResetting}
          className="h-auto p-0"
        >
          Reset Stats
        </Button>
      }
      contentClassName=""
    >
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!(open || isResetting)) {
            setConfirmOpen(false);
          }
        }}
        title="Reset API usage stats?"
        description="Total requests and per-agent usage go back to zero. Requests/min and Requests/hour follow the rate-limit window and are not reset. The previous totals can't be recovered."
        confirmText="Reset"
        variant="destructive"
        isPending={isResetting}
        onConfirm={() => {
          onReset().then(
            () => setConfirmOpen(false),
            // The caller reports the failure; keep the dialog open for a retry.
            () => undefined
          );
        }}
      />
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
    </SettingsSection>
  );
}
