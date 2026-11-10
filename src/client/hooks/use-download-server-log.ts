import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { downloadFile } from '@/client/lib/download-file';
import { trpc } from '@/client/lib/trpc';

/**
 * Downloads the server log file. A mutation rather than a query: the click
 * starts it, and its `isPending` drives the button's pending state.
 */
export function useDownloadServerLog() {
  const utils = trpc.useUtils();
  return useMutation({
    mutationFn: () => utils.admin.downloadLogFile.fetch(),
    onSuccess: (content) => {
      downloadFile({
        data: content,
        mimeType: 'text/plain',
        fileName: `server-${new Date().toISOString().split('T')[0]}.log`,
      });
      toast.success('Log file downloaded');
    },
    meta: { errorToast: "Couldn't download log file." },
  });
}
