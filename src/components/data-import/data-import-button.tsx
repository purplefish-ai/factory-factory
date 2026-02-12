import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { trpc } from '@/frontend/lib/trpc';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';

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

      toast.success('Import completed', { description: summary, duration: 10_000 });
      setConfirmState({ open: false, data: null, summary: '' });

      // Invalidate all queries to refresh data
      await utils.invalidate();

      // Call success callback if provided
      onImportSuccess?.();
    },
    onError: (error) => {
      toast.error(`Import failed: ${error.message}`);
      setConfirmState({ open: false, data: null, summary: '' });
    },
  });

  const buildImportSummary = (data: ParsedExportData): string => {
    const sessionCount =
      'agentSessions' in data.data
        ? data.data.agentSessions.length
        : data.data.claudeSessions.length;

    return [
      `Exported: ${new Date(data.meta.exportedAt).toLocaleString()}`,
      `Version: ${data.meta.version}`,
      '',
      `Projects: ${data.data.projects.length}`,
      `Workspaces: ${data.data.workspaces.length}`,
      `Agent Sessions: ${sessionCount}`,
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
        <Upload className="w-4 h-4 mr-2" />
        {importData.isPending ? 'Importing...' : children || 'Import Data'}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelect}
        className="hidden"
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
