import { DownloadIcon } from '@phosphor-icons/react/dist/csr/Download';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataImportButton } from '@/client/features/data-import/data-import-button';
import { runInBackground } from '@/client/lib/background-task';
import { downloadFile } from '@/client/lib/download-file';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function DataBackupSection() {
  const [isExporting, setIsExporting] = useState(false);
  const utils = trpc.useUtils();

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await utils.admin.exportData.fetch();
      const json = JSON.stringify(data);
      downloadFile({
        data: json,
        mimeType: 'application/json',
        fileName: `factory-factory-backup-${new Date().toISOString().split('T')[0]}.json`,
      });
      toast.success('Export completed');
    } catch (error) {
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCodeIcon className="w-5 h-5" />
          Data Backup
        </CardTitle>
        <CardDescription>
          Export and import logical recovery data with automation paused on restore
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <Button
            onClick={() => {
              runInBackground(handleExport(), 'Could not export backup');
            }}
            disabled={isExporting}
            variant="outline"
            className="w-full sm:w-auto"
          >
            <DownloadIcon className="w-4 h-4 mr-2" />
            {isExporting ? 'Exporting...' : 'Export Data'}
          </Button>
          <DataImportButton variant="outline" className="w-full sm:w-auto" />
        </div>
        <p className="text-sm text-muted-foreground">
          Includes workspace and session metadata, automation definitions and history, delivery
          evidence, and captured closed-session transcripts. Imported automation stays disabled;
          unresolved messages require review and are never sent automatically.
        </p>
        <p className="text-sm text-muted-foreground">
          Credentials, account homes, repository files, and provider-owned history are excluded. A
          full installation backup also needs the database, encryption.key, and archive files.
        </p>
      </CardContent>
    </Card>
  );
}
