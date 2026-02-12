import { FileJson, Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/frontend/lib/trpc';

interface DevServerSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

export function DevServerSetupDialog({
  open,
  onOpenChange,
  workspaceId,
}: DevServerSetupDialogProps) {
  const [runCommand, setRunCommand] = useState('npm run dev');
  const [setupCommand, setSetupCommand] = useState('');
  const [cleanupCommand, setCleanupCommand] = useState('');

  const utils = trpc.useUtils();

  // Mutation to create the factory-factory.json file
  const createConfig = trpc.workspace.createFactoryConfig.useMutation({
    onSuccess: () => {
      utils.workspace.getRunScriptStatus.invalidate({ workspaceId });
      onOpenChange(false);
    },
  });

  const handleCreate = () => {
    createConfig.mutate({
      workspaceId,
      config: {
        scripts: {
          ...(setupCommand && { setup: setupCommand }),
          run: runCommand,
          ...(cleanupCommand && { cleanup: cleanupCommand }),
        },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-5 w-5 text-green-600" />
            Setup Dev Server
          </DialogTitle>
          <DialogDescription>
            Configure your dev server to enable the play button. This will create a{' '}
            <code className="bg-muted px-1 rounded text-xs">factory-factory.json</code> file in your
            project root.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Run Command (Required) */}
          <div className="space-y-2">
            <Label htmlFor="run-command" className="text-sm font-medium">
              Run Command <span className="text-destructive">*</span>
            </Label>
            <Input
              id="run-command"
              placeholder="npm run dev"
              value={runCommand}
              onChange={(e) => setRunCommand(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command to start your dev server. Use{' '}
              <code className="bg-muted px-1">{'{port}'}</code> if your command needs a port (e.g.,{' '}
              <code className="bg-muted px-1">npm run dev -- --port {'{port}'}</code>)
            </p>
          </div>

          {/* Setup Command (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="setup-command" className="text-sm font-medium">
              Setup Command <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="setup-command"
              placeholder="npm install"
              value={setupCommand}
              onChange={(e) => setSetupCommand(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command to run when workspace is initialized (e.g., install dependencies)
            </p>
          </div>

          {/* Cleanup Command (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="cleanup-command" className="text-sm font-medium">
              Cleanup Command <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="cleanup-command"
              placeholder="pkill -f 'node.*dev'"
              value={cleanupCommand}
              onChange={(e) => setCleanupCommand(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command to run when stopping the dev server (e.g., cleanup processes)
            </p>
          </div>

          {/* Preview */}
          <div className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium flex items-center gap-2">
              <FileJson className="h-4 w-4" />
              Configuration Preview
            </Label>
            <Textarea
              readOnly
              value={JSON.stringify(
                {
                  scripts: {
                    ...(setupCommand && { setup: setupCommand }),
                    run: runCommand,
                    ...(cleanupCommand && { cleanup: cleanupCommand }),
                  },
                },
                null,
                2
              )}
              className="font-mono text-xs h-32 resize-none bg-muted"
            />
          </div>

          {/* Common Examples */}
          <div className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium">Common Examples</Label>
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-mono text-xs"
                onClick={() => {
                  setRunCommand('npm run dev');
                  setSetupCommand('npm install');
                  setCleanupCommand('');
                }}
              >
                Node.js / npm
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-mono text-xs"
                onClick={() => {
                  setRunCommand('pnpm dev');
                  setSetupCommand('pnpm install');
                  setCleanupCommand('');
                }}
              >
                pnpm
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-mono text-xs"
                onClick={() => {
                  setRunCommand('cargo run');
                  setSetupCommand('cargo build');
                  setCleanupCommand('');
                }}
              >
                Rust / Cargo
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-mono text-xs"
                onClick={() => {
                  setRunCommand('python -m flask run --port {port}');
                  setSetupCommand('pip install -r requirements.txt');
                  setCleanupCommand('');
                }}
              >
                Python / Flask
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!runCommand.trim() || createConfig.isPending}>
            {createConfig.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <FileJson className="mr-2 h-4 w-4" />
                Create Configuration
              </>
            )}
          </Button>
        </DialogFooter>

        {createConfig.error && (
          <div className="text-sm text-destructive px-6 pb-4">
            Error: {createConfig.error.message}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
