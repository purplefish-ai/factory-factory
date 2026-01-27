'use client';

import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type ScriptType, StartupScriptForm } from '@/components/project/startup-script-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/frontend/lib/trpc';

interface ProjectSettingsDialogProps {
  projectId: string;
  projectName: string;
  currentStartupScriptCommand?: string | null;
  currentStartupScriptPath?: string | null;
}

export function ProjectSettingsDialog({
  projectId,
  projectName,
  currentStartupScriptCommand,
  currentStartupScriptPath,
}: ProjectSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [startupScript, setStartupScript] = useState('');
  const [scriptType, setScriptType] = useState<ScriptType>('command');
  const [error, setError] = useState('');

  const utils = trpc.useUtils();

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      utils.project.getById.invalidate({ id: projectId });
      setOpen(false);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      // Determine initial values based on which script type is configured
      const hasPath = Boolean(currentStartupScriptPath);
      setScriptType(hasPath ? 'path' : 'command');
      setStartupScript(currentStartupScriptPath ?? currentStartupScriptCommand ?? '');
      setError('');
    }
  }, [open, currentStartupScriptCommand, currentStartupScriptPath]);

  const handleSave = () => {
    setError('');
    const trimmedScript = startupScript.trim();

    updateProject.mutate({
      id: projectId,
      startupScriptCommand: scriptType === 'command' ? trimmedScript || null : null,
      startupScriptPath: scriptType === 'path' ? trimmedScript || null : null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Settings className="h-4 w-4 mr-1" />
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          <DialogDescription>{projectName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            <Label>Startup Script</Label>
            <p className="text-xs text-muted-foreground">
              Runs automatically when a new workspace is created to set up the environment.
            </p>

            <StartupScriptForm
              scriptType={scriptType}
              onScriptTypeChange={setScriptType}
              startupScript={startupScript}
              onStartupScriptChange={setStartupScript}
              idPrefix="settings"
              hideHeader
            />

            <p className="text-xs text-muted-foreground">
              {scriptType === 'command'
                ? 'Enter a shell command to run (e.g., npm install)'
                : 'Enter a path to a script file relative to the repository root'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateProject.isPending}>
            {updateProject.isPending && <Spinner className="mr-2" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
