import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { downloadFile } from '@/client/lib/download-file';
import { trpc } from '@/client/lib/trpc';

export function useDownloadServerLog() {
  const [isDownloading, setIsDownloading] = useState(false);
  const utils = trpc.useUtils();

  const download = useCallback(async () => {
    setIsDownloading(true);
    try {
      const content = await utils.admin.downloadLogFile.fetch();
      downloadFile({
        data: content,
        mimeType: 'text/plain',
        fileName: `server-${new Date().toISOString().split('T')[0]}.log`,
      });
      toast.success('Log file downloaded');
    } catch (error) {
      toast.error(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  }, [utils]);

  return { download, isDownloading };
}
