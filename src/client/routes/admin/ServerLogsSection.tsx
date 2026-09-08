import { DownloadIcon, FileTextIcon } from '@phosphor-icons/react';
import { Link as RouterLink } from 'react-router';
import { useDownloadServerLog } from '@/client/hooks/use-download-server-log';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ServerLogsSection() {
  const { download, isDownloading } = useDownloadServerLog();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileTextIcon className="w-5 h-5" />
          Server Logs
        </CardTitle>
        <CardDescription>View and search structured server log entries</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        <RouterLink to="/logs">
          <Button variant="outline" className="w-full sm:w-auto">
            View Logs
          </Button>
        </RouterLink>
        <Button
          variant="outline"
          onClick={download}
          disabled={isDownloading}
          className="w-full sm:w-auto"
        >
          <DownloadIcon className="w-4 h-4 mr-2" />
          {isDownloading ? 'Downloading...' : 'Download Log File'}
        </Button>
      </CardContent>
    </Card>
  );
}
