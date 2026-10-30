import type { Readable, Writable } from 'node:stream';

/** Diagnostic streams may disappear when a terminal or piped consumer closes. */
export function forwardDiagnosticOutput(source: Readable | null, target: Writable): () => void {
  const onError = () => {
    source?.unpipe(target);
    source?.resume();
  };
  target.on('error', onError);
  source?.on('error', onError);
  source?.pipe(target, { end: false });
  return () => {
    source?.unpipe(target);
    source?.off('error', onError);
    target.off('error', onError);
  };
}
