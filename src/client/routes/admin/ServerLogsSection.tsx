import { DownloadIcon } from '@phosphor-icons/react/dist/csr/Download';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { Link as RouterLink } from 'react-router';
import { useDownloadServerLog } from '@/client/hooks/use-download-server-log';
import { Button } from '@/components/ui/button';
import { SettingsSection } from './settings-section';

export function ServerLogsSection() {
  const downloadLog = useDownloadServerLog();

  return (
    <SettingsSection
      title="Server logs"
      icon={<FileTextIcon className="w-5 h-5" />}
      description="View and search structured server log entries"
      contentClassName="flex flex-col gap-2 sm:flex-row sm:gap-3"
    >
      <Button variant="outline" className="w-full sm:w-auto" asChild>
        <RouterLink to="/admin/logs">View logs</RouterLink>
      </Button>
      <Button
        variant="outline"
        onClick={() => downloadLog.mutate()}
        pending={downloadLog.isPending}
        pendingLabel="Downloading…"
        className="w-full sm:w-auto"
      >
        <DownloadIcon />
        Download log file
      </Button>
    </SettingsSection>
  );
}
