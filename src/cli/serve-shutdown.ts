import { unlinkSync } from 'node:fs';
import chalk from 'chalk';

export function removeServePortFile(portFilePath: string): void {
  try {
    unlinkSync(portFilePath);
  } catch {
    // Startup may fail before creating the port file.
  }
}

export function registerServeShutdownHandlers(controller: AbortController, portFilePath: string) {
  const shutdown = (signal: string) => {
    if (!controller.signal.aborted) {
      console.log(chalk.yellow(`\n  🛑 ${signal} received, shutting down...`));
      // Stop advertising the service before the child shutdown grace period.
      removeServePortFile(portFilePath);
      controller.abort();
    }
  };
  const onInterrupt = () => shutdown('SIGINT');
  const onTerminate = () => shutdown('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
}
