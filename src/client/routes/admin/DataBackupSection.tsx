import { DownloadIcon, FileCodeIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataImportButton } from '@/client/features/data-import/data-import-button';
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
      const json = JSON.stringify(data, null, 2);
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
          Export and import database data for backup or migration purposes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <Button
            onClick={handleExport}
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
          Export includes projects, workspaces, session metadata, and user preferences. Caches will
          be rebuilt automatically after import.
        </p>
      </CardContent>
    </Card>
  );
}
