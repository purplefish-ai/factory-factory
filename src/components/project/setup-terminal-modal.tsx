import { lazy, Suspense } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSetupTerminal } from './use-setup-terminal';

const TerminalInstance = lazy(() =>
  import('@/components/workspace/terminal-instance').then((m) => ({ default: m.TerminalInstance }))
);

interface SetupTerminalModalProps {
  open: boolean;
  onClose: () => void;
}

export function SetupTerminalModal({ open, onClose }: SetupTerminalModalProps) {
  const { connected, gaveUp, reconnect, showTerminal, output, handleData, handleResize } =
    useSetupTerminal(open);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-3xl h-[500px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Terminal</DialogTitle>
          <DialogDescription>
            Run authentication commands for your CLIs, then close this dialog.
            <span className="mt-1.5 flex flex-col gap-0.5">
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                claude login
              </code>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                codex login
              </code>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                gh auth login
              </code>
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="relative flex-1 min-h-0 rounded-md overflow-hidden border bg-[#18181b]">
          {showTerminal && (
            <Suspense fallback={null}>
              <TerminalInstance
                onData={handleData}
                onResize={handleResize}
                output={output}
                isActive={open}
              />
            </Suspense>
          )}
          {!connected && (showTerminal || gaveUp) && (
            <output
              className={`absolute top-2 right-2 flex items-center gap-2 rounded px-2 py-0.5 text-xs text-white ${
                gaveUp ? 'bg-red-600/90' : 'bg-yellow-600/90'
              }`}
            >
              {gaveUp ? (
                <>
                  <span>Connection failed.</span>
                  <button type="button" className="underline" onClick={reconnect}>
                    Retry
                  </button>
                </>
              ) : (
                'Reconnecting… input is paused'
              )}
            </output>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
