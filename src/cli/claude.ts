import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { getBundledClaudeCommand } from '@/backend/lib/claude-cli-command';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';

export function registerClaudeCommand(
  program: Command,
  run: (args: string[]) => Promise<number> = runClaudeCommand
): void {
  program.enablePositionalOptions();
  program
    .command('claude')
    .description('Run the bundled Claude CLI (for example: ff claude auth login)')
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args: string[]) => {
      try {
        process.exitCode = await run(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Bundled Claude runtime is unavailable: ${message}`);
        process.exitCode = 1;
      }
    });
}

export async function runClaudeCommand(args: string[]): Promise<number> {
  const command = getBundledClaudeCommand(args);
  const child = spawn(command.command, command.args, {
    stdio: 'inherit',
    env: { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' },
  });
  return await new Promise<number>((resolve, reject) => {
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}
