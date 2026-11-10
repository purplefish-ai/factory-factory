import { UploadIcon } from '@phosphor-icons/react/dist/csr/Upload';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { useDataImportResults } from './data-import-results';

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
  const [confirmState, setConfirmState] = useState<ImportConfirmState>({
    open: false,
    data: null,
    summary: '',
  });
  const utils = trpc.useUtils();
  const { publishImportResult } = useDataImportResults();

  const importData = trpc.admin.importData.useMutation({
    onSuccess: async (result) => {
      publishImportResult(result.results);
      setConfirmState({ open: false, data: null, summary: '' });
      try {
        await utils.invalidate();
      } catch {
        toast.error('Import completed, but refreshing data failed. Reload to refresh.');
      }

      // Call success callback if provided
      onImportSuccess?.();
    },
    onError: (error) => {
      toast.error(`Couldn't import backup. ${error.message}`);
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
    const text = await file.text();
    const json = JSON.parse(text);

    // Validate using exportDataSchema
    const result = exportDataSchema.safeParse(json);
    if (!result.success) {
      throw new Error(`Invalid backup file format: ${result.error.message}`);
    }

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
      toast.error(`Couldn't read file. ${getErrorMessage(error)}`);
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
        pending={importData.isPending}
        pendingLabel="Importing…"
        variant={variant}
        className={className}
      >
        <UploadIcon className="mr-2" />
        {children || 'Import data'}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={(event) => {
          runInBackground(handleFileSelect(event), "Couldn't import backup.");
        }}
        className="hidden"
      />

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmState({ open: false, data: null, summary: '' });
          }
        }}
        title="Confirm import"
        description={`Review the data to be imported. Existing records will be skipped.\n\n${confirmState.summary}`}
        confirmText="Import"
        pendingText="Importing…"
        onConfirm={handleConfirmImport}
        isPending={importData.isPending}
      />
    </>
  );
}
