import { lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSetupTerminal } from './use-setup-terminal';

const TerminalInstance = lazy(() =>
  import('@/client/components/terminal-instance').then((m) => ({
    default: m.TerminalInstance,
  }))
);

interface SetupTerminalModalProps {
  open: boolean;
  onClose: () => void;
}

export function SetupTerminalModal({ open, onClose }: SetupTerminalModalProps) {
  const {
    connected,
    gaveUp,
    reconnect,
    showTerminal,
    output,
    authenticate,
    authenticatingProvider,
    handleData,
    handleResize,
  } = useSetupTerminal(open);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-3xl h-[500px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Terminal</DialogTitle>
          <DialogDescription>
            Use the sign-in buttons for Claude and Codex. The ff commands below require the ff CLI
            to be installed.
            <span className="mt-1.5 flex flex-col gap-0.5">
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                ff claude auth login
              </code>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                ff codex login
              </code>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm w-fit">
                gh auth login
              </code>
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || authenticatingProvider !== null}
            aria-busy={authenticatingProvider === 'CLAUDE'}
            onClick={() => authenticate('CLAUDE')}
          >
            Sign in to Claude
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || authenticatingProvider !== null}
            aria-busy={authenticatingProvider === 'CODEX'}
            onClick={() => authenticate('CODEX')}
          >
            Sign in to Codex
          </Button>
        </div>
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
                  <span>{showTerminal ? 'Connection lost.' : 'Connection failed.'}</span>
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
