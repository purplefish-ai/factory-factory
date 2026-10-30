import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { terminateDisposableProcessTree } from '@/backend/lib/owned-process-cleanup';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGKILL: 137,
};

export function registerProviderCommand(
  program: Command,
  options: {
    name: string;
    label: string;
    example: string;
    run: (args: string[]) => Promise<number>;
  }
): void {
  program.enablePositionalOptions();
  program
    .command(options.name)
    .description(`Run the bundled ${options.label} CLI (for example: ${options.example})`)
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args: string[]) => {
      try {
        process.exitCode = await options.run(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Bundled ${options.label} runtime is unavailable: ${message}`);
        process.exitCode = 1;
      }
    });
}

export async function runProviderCommand(command: {
  command: string;
  args: string[];
}): Promise<number> {
  const child = spawn(command.command, command.args, {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' },
  });
  return await new Promise<number>((resolve, reject) => {
    let termination: Promise<void> | undefined;
    const onResize = () => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, 'SIGWINCH');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          console.error('Could not resize the provider terminal:', error);
        }
      }
    };
    const forward = (initialSignal: 'SIGINT' | 'SIGTERM') => {
      if (termination !== undefined) {
        return;
      }
      termination = Promise.resolve().then(() =>
        terminateDisposableProcessTree(child, { initialSignal })
      );
      void termination.catch((error: unknown) => {
        cleanup();
        reject(error);
      });
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('SIGWINCH', onResize);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    if (process.platform !== 'win32') {
      process.on('SIGWINCH', onResize);
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      const status = code ?? (signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1);
      const finish = () => {
        cleanup();
        resolve(status);
      };
      if (termination !== undefined) {
        void termination.then(finish, (error: unknown) => {
          cleanup();
          reject(error);
        });
      } else {
        finish();
      }
    });
  });
}
