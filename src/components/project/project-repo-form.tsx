import { CheckCircle2Icon, FolderOpenIcon } from 'lucide-react';
import { type ScriptType, StartupScriptForm } from '@/components/project/startup-script-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

export interface ProjectRepoFormProps {
  error: string;
  repoPath: string;
  setRepoPath: (value: string) => void;
  isElectron: boolean;
  handleBrowse: () => Promise<void>;
  factoryConfigExists: boolean;
  helperText: string;
  scriptType: ScriptType;
  setScriptType: (value: ScriptType) => void;
  startupScript: string;
  setStartupScript: (value: string) => void;
  idPrefix: string;
  onSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  footerActions?: React.ReactNode;
  submitFullWidth?: boolean;
}

export function ProjectRepoForm({
  error,
  repoPath,
  setRepoPath,
  isElectron,
  handleBrowse,
  factoryConfigExists,
  helperText,
  scriptType,
  setScriptType,
  startupScript,
  setStartupScript,
  idPrefix,
  onSubmit,
  isSubmitting,
  submitLabel,
  submittingLabel,
  footerActions,
  submitFullWidth = false,
}: ProjectRepoFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="repoPath">Repository Path</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            id="repoPath"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="font-mono"
            placeholder="/Users/you/code/my-project"
            autoFocus
          />
          {isElectron && (
            <Button type="button" variant="outline" onClick={handleBrowse}>
              <FolderOpenIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
        {factoryConfigExists && repoPath.trim() && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2Icon className="h-4 w-4" />
            <span>factory-factory.json detected</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{helperText}</p>
      </div>

      <StartupScriptForm
        scriptType={scriptType}
        onScriptTypeChange={setScriptType}
        startupScript={startupScript}
        onStartupScriptChange={setStartupScript}
        idPrefix={idPrefix}
      />

      {footerActions ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-4">
          {footerActions}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner className="mr-2" />}
            {isSubmitting ? submittingLabel : submitLabel}
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          className={submitFullWidth ? 'w-full' : undefined}
          disabled={isSubmitting}
        >
          {isSubmitting && <Spinner className="mr-2" />}
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
      )}
    </form>
  );
}
