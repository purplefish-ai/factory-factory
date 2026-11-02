import { UploadIcon } from '@phosphor-icons/react/dist/csr/Upload';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { RecoveryImportReport } from '@/shared/recovery-import-report';
import {
  assertRecoveryWireBudget,
  MAX_RECOVERY_HTTP_BODY_BYTES,
} from '@/shared/recovery-wire-budget';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { DataImportResultDialog } from './data-import-result-dialog';

type ParsedExportData = z.infer<typeof exportDataSchema>;

interface ImportConfirmState {
  open: boolean;
  data: ParsedExportData | null;
  summary: string;
}

interface DataImportButtonProps {
  onImportSuccess?: () => void;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link' | 'destructive';
  className?: string;
  children?: React.ReactNode;
}

export function DataImportButton({
  onImportSuccess,
  variant = 'outline',
  className,
  children,
}: DataImportButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const afterReportClose = useRef<(() => Promise<void>) | null>(null);
  const [report, setReport] = useState<RecoveryImportReport | null>(null);
  const [confirmState, setConfirmState] = useState<ImportConfirmState>({
    open: false,
    data: null,
    summary: '',
  });
  const utils = trpc.useUtils();

  const importData = trpc.admin.importData.useMutation({
    onSuccess: async (result) => {
      const { results } = result;
      const summary = [
        `Projects: ${results.projects.imported} imported, ${results.projects.skipped} skipped`,
        `Workspaces: ${results.workspaces.imported} imported, ${results.workspaces.skipped} skipped`,
        `Agent Sessions: ${results.agentSessions.imported} imported, ${results.agentSessions.skipped} skipped`,
        `Terminal Sessions: ${results.terminalSessions.imported} imported, ${results.terminalSessions.skipped} skipped`,
        `User Settings: ${results.userSettings.imported ? 'imported' : results.userSettings.skipped ? 'skipped (exists)' : 'none'}`,
      ].join('\n');

      const recovery = results.recovery;
      const skipped = recovery.skipped.length;
      const imported = recovery.models.reduce((sum, row) => sum + row.imported, 0);
      const description = `${summary}\nDurable history and archives: ${imported} imported, ${skipped} skipped`;
      if (skipped > 0) {
        toast.warning('Import completed with skipped history', { description, duration: 10_000 });
      } else {
        toast.success('Import completed', { description, duration: 10_000 });
      }
      const hasReport = recovery.models.some((row) => row.imported + row.skipped > 0);
      setConfirmState({ open: false, data: null, summary: '' });

      const complete = async () => {
        await utils.invalidate();
        onImportSuccess?.();
      };
      // Refreshing project queries can unmount first-project onboarding too.
      // Keep both refresh and navigation behind the report's dismissal.
      if (hasReport) {
        afterReportClose.current = complete;
        setReport(recovery);
      } else {
        await complete();
      }
    },
    onError: (error) => {
      toast.error(`Import failed: ${error.message}`);
      setConfirmState({ open: false, data: null, summary: '' });
    },
  });

  const buildImportSummary = (data: ParsedExportData): string => {
    return [
      `Exported: ${new Date(data.meta.exportedAt).toLocaleString()}`,
      `Version: ${data.meta.version}`,
      '',
      `Projects: ${data.data.projects.length}`,
      `Workspaces: ${data.data.workspaces.length}`,
      `Agent Sessions: ${data.data.agentSessions.length}`,
      `Terminal Sessions: ${data.data.terminalSessions.length}`,
      `User Settings: ${data.data.userSettings ? 'Yes' : 'No'}`,
    ].join('\n');
  };

  const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Unknown error';
  };

  const validateAndParseFile = async (file: File): Promise<ParsedExportData> => {
    if (file.size > MAX_RECOVERY_HTTP_BODY_BYTES) {
      throw new Error('Backup file exceeds the 65 MiB file limit.');
    }
    const text = await file.text();
    const json: unknown = JSON.parse(text);
    assertRecoveryWireBudget(json);

    // Validate using exportDataSchema
    const result = exportDataSchema.safeParse(json);
    if (!result.success) {
      throw new Error(`Invalid backup file format: ${result.error.message}`);
    }

    // Schema normalization adds defaults before the mutation is serialized.
    assertRecoveryWireBudget(result.data);
    return result.data;
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const data = await validateAndParseFile(file);

      // Show confirmation dialog with summary
      setConfirmState({
        open: true,
        data,
        summary: buildImportSummary(data),
      });
    } catch (error) {
      toast.error(`Failed to read file: ${getErrorMessage(error)}`);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleConfirmImport = () => {
    if (confirmState.data) {
      importData.mutate(confirmState.data);
    }
  };

  return (
    <>
      <Button
        onClick={() => fileInputRef.current?.click()}
        disabled={importData.isPending}
        variant={variant}
        className={className}
      >
        <UploadIcon className="w-4 h-4 mr-2" />
        {importData.isPending ? 'Importing...' : children || 'Import Data'}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={(event) => {
          runInBackground(handleFileSelect(event), 'Could not import backup');
        }}
        className="hidden"
      />

      <DataImportResultDialog
        report={report}
        onClose={() => {
          setReport(null);
          const complete = afterReportClose.current;
          afterReportClose.current = null;
          if (complete) {
            runInBackground(complete(), 'Could not finish import');
          }
        }}
      />
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmState({ open: false, data: null, summary: '' });
          }
        }}
        title="Confirm Import"
        description={`Review the data to be imported. Existing records will be skipped.\n\n${confirmState.summary}`}
        confirmText="Import"
        onConfirm={handleConfirmImport}
        isPending={importData.isPending}
      />
    </>
  );
}
