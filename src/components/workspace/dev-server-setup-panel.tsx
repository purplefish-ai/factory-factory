import { FileJson, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';

interface DevServerSetupPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentConfig?: {
    run?: string | null;
    setup?: string | null;
    postRun?: string | null;
    cleanup?: string | null;
  };
  onSave: (config: FactoryConfig) => void;
  isPending?: boolean;
  error?: { message: string } | null;
}

export function DevServerSetupPanel({
  open,
  onOpenChange,
  currentConfig,
  onSave,
  isPending,
  error,
}: DevServerSetupPanelProps) {
  const isEditing = !!currentConfig?.run;

  const [runCommand, setRunCommand] = useState('');
  const [setupCommand, setSetupCommand] = useState('');
  const [postRunCommand, setPostRunCommand] = useState('');
  const [cleanupCommand, setCleanupCommand] = useState('');

  // Reset form fields when panel opens
  useEffect(() => {
    if (open) {
      setRunCommand(currentConfig?.run ?? 'npm run dev');
      setSetupCommand(currentConfig?.setup ?? '');
      setPostRunCommand(currentConfig?.postRun ?? '');
      setCleanupCommand(currentConfig?.cleanup ?? '');
    }
  }, [open, currentConfig]);

  const handleSave = () => {
    onSave({
      scripts: {
        ...(setupCommand && { setup: setupCommand }),
        run: runCommand,
        ...(postRunCommand && { postRun: postRunCommand }),
        ...(cleanupCommand && { cleanup: cleanupCommand }),
      },
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Play className="h-5 w-5 text-green-600" />
            {isEditing ? 'Edit Dev Server' : 'Setup Dev Server'}
          </SheetTitle>
          <SheetDescription>
            {isEditing
              ? 'Update your dev server configuration. Changes will be written to factory-factory.json.'
              : 'Configure your dev server to enable the play button. This will create a factory-factory.json file in your project root.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-6">
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

          {/* Post-Run Command (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="post-run-command" className="text-sm font-medium">
              Post-Run Command <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="post-run-command"
              placeholder="cloudflared tunnel --url http://localhost:{port}"
              value={postRunCommand}
              onChange={(e) => setPostRunCommand(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command to run after the dev server starts (e.g., start a tunnel). Supports{' '}
              <code className="bg-muted px-1">{'{port}'}</code> placeholder. Runs in parallel and is
              killed when the dev server stops.
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

          {/* Common Examples */}
          <div className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium">Common Examples</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="justify-start font-mono text-xs"
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
                className="justify-start font-mono text-xs"
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
                className="justify-start font-mono text-xs"
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
                className="justify-start font-mono text-xs"
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
                    ...(postRunCommand && { postRun: postRunCommand }),
                    ...(cleanupCommand && { cleanup: cleanupCommand }),
                  },
                },
                null,
                2
              )}
              className="font-mono text-xs h-32 resize-none bg-muted"
            />
          </div>
        </div>

        <div className="border-t pt-4 space-y-3">
          {error && <div className="text-sm text-destructive">Error: {error.message}</div>}
          <SheetFooter className="flex flex-row gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!runCommand.trim() || isPending}
              className="flex-1"
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <FileJson className="mr-2 h-4 w-4" />
                  {isEditing ? 'Save Configuration' : 'Create Configuration'}
                </>
              )}
            </Button>
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  );
}
