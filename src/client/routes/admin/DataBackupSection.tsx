import { DownloadIcon } from '@phosphor-icons/react/dist/csr/Download';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DataImportButton } from '@/client/features/data-import/data-import-button';
import { downloadFile } from '@/client/lib/download-file';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { SettingsSection } from './settings-section';

export function DataBackupSection() {
  const utils = trpc.useUtils();
  const exportData = useMutation({
    mutationFn: () => utils.admin.exportData.fetch(),
    onSuccess: (data) => {
      downloadFile({
        data: JSON.stringify(data, null, 2),
        mimeType: 'application/json',
        fileName: `factory-factory-backup-${new Date().toISOString().split('T')[0]}.json`,
      });
      toast.success('Export completed');
    },
    meta: { errorToast: "Couldn't export backup." },
  });

  return (
    <SettingsSection
      title="Data backup"
      icon={<FileCodeIcon className="w-5 h-5" />}
      description="Export and import partial logical metadata for backup or migration"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
        <Button
          onClick={() => exportData.mutate()}
          pending={exportData.isPending}
          pendingLabel="Exporting…"
          variant="outline"
          className="w-full sm:w-auto"
        >
          <DownloadIcon className="mr-2" />
          Export data
        </Button>
        <DataImportButton variant="outline" className="w-full sm:w-auto" />
      </div>
      <p className="text-sm text-muted-foreground">
        Partial export includes projects, workspaces, session metadata, preferences and periodic
        configuration, workspace links to newly imported disabled tasks and retained execution
        history. RUNNING executions restore FAILED as historical only, with unknown provider outcome
        and no resume authority. Repository and worktree files, provider history bytes, archives,
        mail, secrets, native account homes and live runtime authority are excluded. Automation
        definition bodies and execution preferences restore disabled; connection bindings, event
        configuration, proposal provenance and automation history are excluded. Inspect recovered
        bodies and author new complete event configuration where editing is available; archived
        projects and definitions that have reached their revision limit retain their ordinary
        editing restrictions. Slack connection metadata restores disconnected, without tokens;
        reconnect manually in Slack settings. GitHub connections and event configuration are
        excluded. Provider-session identities may remain metadata. Workspace.creationMetadata,
        WorkspacePR.observation on actual included PR rows, AgentSession.providerMetadata and
        PeriodicTaskExecution.launchSnapshot preserve SQL NULL versus top-level JSON null.
      </p>
    </SettingsSection>
  );
}
