import { downloadFile } from '@/client/lib/download-file';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { RecoveryImportReport } from '@/shared/recovery-import-report';

const historyLabel = (model: string) => model.replace(/([a-z])([A-Z])/g, '$1 $2');

function downloadReport(report: RecoveryImportReport) {
  downloadFile({
    data: JSON.stringify(report, null, 2),
    fileName: 'recovery-import-report.json',
    mimeType: 'application/json',
  });
}
export function DataImportResultDialog({
  report,
  onClose,
}: {
  report: RecoveryImportReport | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Recovery import results</AlertDialogTitle>
          <AlertDialogDescription>
            Existing destination records and their ownership stay intact. Skipped history was not
            restored.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <table className="w-full text-sm">
          <caption className="sr-only">Durable history and archive import counts</caption>
          <thead>
            <tr>
              <th className="text-left">History</th>
              <th>Imported</th>
              <th>Skipped</th>
            </tr>
          </thead>
          <tbody>
            {report?.models
              .filter((row) => row.imported + row.skipped > 0)
              .map((row) => (
                <tr key={row.model}>
                  <td>{historyLabel(row.model)}</td>
                  <td className="text-center">{row.imported}</td>
                  <td className="text-center">{row.skipped}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {!!report?.skipped.length && (
          <div className="space-y-2 text-sm">
            <p>
              {report.skipped.length} retained{' '}
              {report.skipped.length === 1 ? 'record was' : 'records were'} skipped. The full report
              contains every skipped identity.
            </p>
            <ul className="max-h-48 overflow-y-auto break-words space-y-2">
              {report.skipped.slice(0, 100).map((row) => (
                <li key={`${row.model}:${row.identity}`}>
                  {historyLabel(row.model)} {row.identity}:{' '}
                  {row.reason === 'EXISTING_IDENTITY'
                    ? 'identity already exists'
                    : 'conflicting unique identity or skipped parent'}
                </li>
              ))}
            </ul>
          </div>
        )}
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (report) {
                downloadReport(report);
              }
            }}
          >
            Download full report
          </Button>
          <AlertDialogAction onClick={onClose}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
