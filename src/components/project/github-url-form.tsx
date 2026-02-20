import { AlertTriangleIcon, CheckCircle2Icon, TerminalIcon } from 'lucide-react';
import { type ScriptType, StartupScriptForm } from '@/components/project/startup-script-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

function AuthStatusSection({
  authStatus,
  isCheckingAuth,
  onOpenTerminal,
}: {
  authStatus: { authenticated: boolean; user?: string; error?: string } | undefined;
  isCheckingAuth: boolean;
  onOpenTerminal: () => void;
}) {
  if (isCheckingAuth) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          <span>Checking GitHub authentication...</span>
        </div>
      </div>
    );
  }

  if (!authStatus) {
    return null;
  }

  if (authStatus.authenticated) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2Icon className="h-4 w-4" />
          <span>Authenticated{authStatus.user ? ` as ${authStatus.user}` : ''}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400">
        <AlertTriangleIcon className="h-4 w-4" />
        <span>Not authenticated — private repos will fail to clone</span>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onOpenTerminal}>
        <TerminalIcon className="mr-2 h-4 w-4" />
        Open Terminal to Login
      </Button>
    </div>
  );
}

export interface GithubUrlFormProps {
  error: string;
  githubUrl: string;
  setGithubUrl: (value: string) => void;
  parsedRepo: { owner: string; repo: string } | null;
  authStatus: { authenticated: boolean; user?: string; error?: string } | undefined;
  isCheckingAuth: boolean;
  onOpenTerminal: () => void;
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

export function GithubUrlForm({
  error,
  githubUrl,
  setGithubUrl,
  parsedRepo,
  authStatus,
  isCheckingAuth,
  onOpenTerminal,
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
}: GithubUrlFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-githubUrl`}>GitHub Repository URL</Label>
        <Input
          type="text"
          id={`${idPrefix}-githubUrl`}
          value={githubUrl}
          onChange={(e) => setGithubUrl(e.target.value)}
          className="font-mono"
          placeholder="https://github.com/owner/repo"
          autoFocus
        />
        {parsedRepo && githubUrl.trim() && (
          <p className="text-xs text-muted-foreground">
            Will clone{' '}
            <span className="font-mono font-medium">
              {parsedRepo.owner}/{parsedRepo.repo}
            </span>
          </p>
        )}
        {githubUrl.trim() && !parsedRepo && (
          <p className="text-xs text-destructive">
            Invalid GitHub URL. Expected format: https://github.com/owner/repo
          </p>
        )}
      </div>

      <AuthStatusSection
        authStatus={authStatus}
        isCheckingAuth={isCheckingAuth}
        onOpenTerminal={onOpenTerminal}
      />

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
          <Button type="submit" disabled={isSubmitting || !parsedRepo}>
            {isSubmitting && <Spinner className="mr-2" />}
            {isSubmitting ? submittingLabel : submitLabel}
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          className={submitFullWidth ? 'w-full' : undefined}
          disabled={isSubmitting || !parsedRepo}
        >
          {isSubmitting && <Spinner className="mr-2" />}
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
      )}
    </form>
  );
}
