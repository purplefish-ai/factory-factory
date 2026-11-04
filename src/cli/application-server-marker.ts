import { mkdirSync, rmSync } from 'node:fs';

/** Startup can call process.exit before asynchronous finally blocks get a turn. */
export function registerApplicationServerMarker(path: string): () => void {
  mkdirSync(path, { recursive: true });
  const cleanup = () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* Exit cleanup cannot prevent the process from terminating. */
    }
  };
  const interrupt = () => signal('SIGINT');
  const terminate = () => signal('SIGTERM');
  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    cleanup();
    // once() removed our handler before invoking it. Preserve default signal
    // termination during migrations, or let the installed graceful handler run.
    if (process.listenerCount(name) === 0) {
      process.kill(process.pid, name);
    }
  };
  process.once('exit', cleanup);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return () => {
    cleanup();
    process.off('exit', cleanup);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
}
